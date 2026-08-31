import { describe, expect, it, vi } from 'vitest'

import type { RunPersistence } from '../../../manager/run/persistence.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import { NamzuError } from '../../../types/errors/index.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import { ResultAssembler } from '../result.js'

/**
 * A 503 that survived every in-turn recovery — retry with jitter, the
 * one-shot compaction relief, mid-stream salvage — settled the run as
 * `failed`, identically to a bad API key. The host could not tell them
 * apart, and recovering meant knowing about checkpoints and driving
 * replay itself.
 *
 * The state was never the problem: checkpoints are written every iteration
 * by default and the failed run is persisted with full messages. Only the
 * settle and the signal were missing.
 */

const RID = 'run_1' as RunId
const CP = 'cp_7' as CheckpointId

function makeLogger() {
	const calls: Array<{ level: string; message: string }> = []
	const self = {
		calls,
		info: (m: string) => calls.push({ level: 'info', message: m }),
		warn: (m: string) => calls.push({ level: 'warn', message: m }),
		error: (m: string) => calls.push({ level: 'error', message: m }),
		debug: vi.fn(),
	}
	;(self as unknown as { child: () => unknown }).child = () => self
	return self
}

async function settle(err: unknown, resumeFrom?: CheckpointId) {
	const emitted: RunEvent[] = []
	const pending: RunEvent[] = []
	const marks: string[] = []
	const spanStatus: number[] = []

	const assembler = new ResultAssembler({
		runMgr: {
			id: RID,
			currentIteration: 4,
			stopReason: undefined,
			markFailed: () => marks.push('failed'),
			setStopReason: (reason: string) => marks.push(`stop:${reason}`),
			setLastError: () => marks.push('lastError'),
			getRun: () => ({ id: RID }) as unknown as Run,
			// LOG-14: `handleError` now calls `recordAudit` on the run_failed
			// path. The `describe('a failure that pausing would not help', ...)`
			// tests below reach it; the `describe('a transient failure with
			// somewhere to resume from', ...)` tests take the earlier `paused`
			// return and never touch this.
			recordAudit: async () => undefined as never,
		} as unknown as RunPersistence,
		planManager: { isActive: false, failPlan: () => marks.push('planFailed') } as never,
		activityStore: { enabled: false } as never,
		log: makeLogger() as never,
		emitEvent: async (event: RunEvent) => {
			emitted.push(event)
			pending.push(event)
		},
		drainPending: function* () {
			while (pending.length > 0) {
				const next = pending.shift()
				if (next) yield next
			}
		},
		resumeCheckpointId: () => resumeFrom,
	})

	const span = {
		setAttributes: () => {},
		setStatus: (s: { code: number }) => spanStatus.push(s.code),
		recordException: () => {},
		end: () => {},
	} as never

	for await (const _event of assembler.handleError(err, span)) {
		// drain
	}
	return { emitted, marks, spanStatus }
}

const transient = () =>
	new ProviderError({ code: 'overloaded', message: 'try later', providerId: 'test', status: 529 })

const permanent = () =>
	new ProviderError({ code: 'auth', message: 'bad key', providerId: 'test', status: 401 })

describe('a transient failure with somewhere to resume from', () => {
	it('settles paused, not failed', async () => {
		const { emitted, marks } = await settle(transient(), CP)

		expect(emitted.map((e) => e.type)).toEqual(['run_paused'])
		expect(marks).toContain('stop:paused')
		expect(marks).not.toContain('failed')
	})

	it('names the checkpoint a host should resume from', async () => {
		const { emitted } = await settle(transient(), CP)
		const paused = emitted[0]
		expect(paused?.type === 'run_paused' && paused.checkpointId).toBe(CP)
	})

	it('leaves the span OK, so it does not land in an error dashboard', async () => {
		// SpanStatusCode.OK === 1, ERROR === 2.
		const { spanStatus } = await settle(transient(), CP)
		expect(spanStatus).toEqual([1])
	})

	it('records why it stopped without marking the run failed', async () => {
		const { marks } = await settle(transient(), CP)
		expect(marks).toContain('lastError')
	})

	it('keeps current driver classification, retry delay and remedy on the pause', async () => {
		const current = new ProviderRequestError({
			kind: 'throttle',
			providerId: 'openai',
			providerCode: 'rate_limit_exceeded',
			status: 429,
			retryAfterMs: 12_000,
			detail: 'organization window exhausted',
		})
		const { emitted } = await settle(current, CP)
		const paused = emitted[0]

		expect(paused).toMatchObject({
			type: 'run_paused',
			checkpointId: CP,
			failure: {
				code: 'provider_error',
				retryable: true,
				details: { providerCode: 'rate_limit', status: 429, retryAfterMs: 12_000 },
			},
			providerError: {
				kind: 'throttle',
				providerId: 'openai',
				status: 429,
				retryAfterMs: 12_000,
				detail: 'organization window exhausted',
			},
			explanation: { id: 'provider.rate_limit' },
		})
	})
})

describe('a failure that pausing would not help', () => {
	it('still fails on a permanent error', async () => {
		// Pausing on a bad API key would invite a resume that cannot work.
		const { emitted, marks } = await settle(permanent(), CP)

		expect(emitted.map((e) => e.type)).toEqual(['run_failed'])
		expect(marks).toContain('failed')
	})

	it('still fails when there is no checkpoint to resume from', async () => {
		// Pausing with nowhere to resume from is a run that can never be
		// picked up again — strictly worse than reporting the failure.
		const { emitted } = await settle(transient(), undefined)
		expect(emitted.map((e) => e.type)).toEqual(['run_failed'])
	})

	it('still fails on a namzu error that is not retryable', async () => {
		const { emitted } = await settle(
			new NamzuError({ code: 'invalid_config', message: 'no model' }),
			CP,
		)
		expect(emitted.map((e) => e.type)).toEqual(['run_failed'])
	})

	it('carries the explanation on the failure it does report', async () => {
		const { emitted } = await settle(permanent(), CP)
		const failed = emitted[0]
		expect(failed?.type === 'run_failed' && failed.explanation?.id).toBe('provider.auth')
	})
})
