import { describe, expect, it, vi } from 'vitest'

import { mapTurnToA2AEvent } from '../../../bridge/a2a/mapper.js'
import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { NamzuError } from '../../../types/errors/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { SessionEvent, Turn } from '../../../types/session/index.js'
import type { SessionEventDraft } from '../events.js'
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

const RID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId
const SESSION = 'c3d8a0f1-2b4e-4f6a-9c1d-7e8f9a0b1c2d' as SessionId

function makeLogger() {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	;(self as unknown as { child: () => unknown }).child = () => self
	return self as never
}

async function failWith(err: unknown): Promise<SessionEvent[]> {
	const emitted: SessionEvent[] = []
	const pending: SessionEvent[] = []

	const assembler = new ResultAssembler({
		recorder: {
			turnId: RID,
			isActive: true,
			settlement: (status: string) => ({
				status,
				iterations: 1,
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
				durationMs: 0,
				resultSource: 'model',
				abandonedTaskIds: [],
				abandonedJobIds: [],
			}),
			currentIteration: 1,
			stopReason: undefined,
			markFailed: () => {},
			getTurn: () => ({ id: RID }) as unknown as Turn,
			// LOG-14: `handleError` now calls `recordAudit` on the run_failed path,
			// which every test in this file reaches.
			recordAudit: async () => undefined as never,
		} as unknown as TurnRecorder,
		planManager: { isActive: false, failPlan: () => {} } as never,
		activityStore: { enabled: false } as never,
		log: makeLogger(),
		emitEvent: async (event: SessionEventDraft) => {
			emitted.push(event as SessionEvent)
			pending.push(event as SessionEvent)
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

const failureOf = (events: SessionEvent[]) =>
	events.find((e): e is Extract<SessionEvent, { type: 'turn_failed' }> => e.type === 'turn_failed')
		?.failure

describe('what run_failed carries', () => {
	it('keeps the flattened message, for consumers that only render a string', async () => {
		const events = await failWith(new Error('boom'))
		const failed = events.find((e) => e.type === 'turn_failed')
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
		const event = mapTurnToA2AEvent(
			{
				type: 'turn_failed',
				sessionId: SESSION,
				turnId: RID,
				error: 'slow down',
				failure: { code: 'provider_error', message: 'slow down', retryable: true },
			} as SessionEvent,
			'ctx-1',
		)

		// As metadata, not folded into the text: a peer deciding whether to
		// retry needs the flag, not prose it would have to pattern-match.
		expect(event?.metadata).toMatchObject({ code: 'provider_error', retryable: true })
	})

	it('still maps a failure that carries no classification', () => {
		const event = mapTurnToA2AEvent(
			{ type: 'turn_failed', sessionId: SESSION, turnId: RID, error: 'boom' } as SessionEvent,
			'ctx-1',
		)
		expect(event).not.toBeNull()
		expect(event?.metadata).toBeUndefined()
	})
})
