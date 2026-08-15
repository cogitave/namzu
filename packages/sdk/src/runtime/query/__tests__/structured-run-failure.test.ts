import { describe, expect, it, vi } from 'vitest'

import { mapRunToA2AEvent } from '../../../bridge/a2a/mapper.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { NamzuError } from '../../../types/errors/index.js'
import type { RunId } from '../../../types/ids/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import { ResultAssembler } from '../result.js'

/**
 * `run_failed` carried a bare string, and the run boundary flattened the
 * throwable into it — discarding `code`, `status`, `retryAfterMs`,
 * `retryable`, `details` and the whole cause chain.
 *
 * This was never "the taxonomy is unbuilt". The classifier at the provider
 * boundary already walks the cause chain over status, errno and
 * `Retry-After`, so a fully-populated error genuinely arrived here and was
 * thrown away one line later — and `toPlatformError`, the projection
 * written for exactly this, had no callers outside its own test. The fix is
 * widening the event, not retrofitting hundreds of throw sites.
 */

const RID = 'run_1' as RunId

function makeLogger() {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	;(self as unknown as { child: () => unknown }).child = () => self
	return self as never
}

async function failWith(err: unknown): Promise<RunEvent[]> {
	const emitted: RunEvent[] = []
	const pending: RunEvent[] = []

	const assembler = new ResultAssembler({
		runMgr: {
			id: RID,
			currentIteration: 1,
			stopReason: undefined,
			markFailed: () => {},
			getRun: () => ({ id: RID }) as unknown as Run,
			// LOG-14: `handleError` now calls `recordAudit` on the run_failed path,
			// which every test in this file reaches.
			recordAudit: async () => undefined as never,
		} as unknown as RunPersistence,
		planManager: { isActive: false, failPlan: () => {} } as never,
		activityStore: { enabled: false } as never,
		log: makeLogger(),
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
	})

	const span = {
		setAttributes: () => {},
		setStatus: () => {},
		recordException: () => {},
		end: () => {},
	} as never

	for await (const _event of assembler.handleError(err, span)) {
		// drain
	}
	return emitted
}

const failureOf = (events: RunEvent[]) =>
	events.find((e): e is Extract<RunEvent, { type: 'run_failed' }> => e.type === 'run_failed')
		?.failure

describe('what run_failed carries', () => {
	it('keeps the flattened message, for consumers that only render a string', async () => {
		const events = await failWith(new Error('boom'))
		const failed = events.find((e) => e.type === 'run_failed')
		expect(failed && 'error' in failed && failed.error).toContain('boom')
	})

	it('keeps a provider classification instead of flattening it away', async () => {
		const failure = failureOf(
			await failWith(
				new ProviderError({
					code: 'rate_limit',
					message: 'slow down',
					providerId: 'test',
					status: 429,
					retryAfterMs: 3_000,
				}),
			),
		)

		// "rate limited, retryable, wait 3s" and "your key is wrong" are the
		// same sentence to a host that only receives a string.
		expect(failure?.retryable).toBe(true)
		expect(failure?.details).toMatchObject({
			providerCode: 'rate_limit',
			status: 429,
			retryAfterMs: 3_000,
		})
	})

	it('keeps a namzu error code', async () => {
		const failure = failureOf(
			await failWith(new NamzuError({ code: 'invalid_config', message: 'bad argument' })),
		)
		expect(failure?.code).toBe('invalid_config')
		expect(failure?.retryable).toBe(false)
	})

	it('normalizes something that was never an Error at all', async () => {
		// A thrown string still has to produce the declared shape, or the
		// host is back to an `instanceof` ladder.
		const failure = failureOf(await failWith('just a string'))
		expect(failure?.code).toBeTruthy()
		expect(failure?.message).toContain('just a string')
	})
})

describe('what the bridges do with it', () => {
	it('sends the classification to a remote peer as metadata', () => {
		const event = mapRunToA2AEvent(
			{
				type: 'run_failed',
				runId: RID,
				error: 'slow down',
				failure: { code: 'provider_error', message: 'slow down', retryable: true },
			},
			'ctx-1',
		)

		// As metadata, not folded into the text: a peer deciding whether to
		// retry needs the flag, not prose it would have to pattern-match.
		expect(event?.metadata).toMatchObject({ code: 'provider_error', retryable: true })
	})

	it('still maps a failure that carries no classification', () => {
		const event = mapRunToA2AEvent({ type: 'run_failed', runId: RID, error: 'boom' }, 'ctx-1')
		expect(event).not.toBeNull()
		expect(event?.metadata).toBeUndefined()
	})
})
