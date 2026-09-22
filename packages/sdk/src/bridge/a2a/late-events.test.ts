import { describe, expect, it } from 'vitest'

import { fixtureId } from '../../test-support/ids.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import { mapTurnToA2AEvent } from './mapper.js'
import { messageToA2A } from './message.js'

/**
 * Three mappings added after this bridge's original test was written,
 * none of which it covered — and a peer on the far side has no schema to
 * check them against, only the shapes it happens to receive.
 */

const SID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as SessionId
const TID = '0199b3a0-0000-7000-8000-00000000000a' as TurnId
const ctx = 'ctx_1'

const map = (event: SessionEvent) => mapTurnToA2AEvent(event, ctx)

describe('what a remote peer is told', () => {
	it('reports a retry as still running, not as a failure', () => {
		// The call has not given up, and a peer that read this as failed
		// would tear down a task that is about to succeed.
		const mapped = map({
			type: 'provider_retry',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			attempt: 2,
			maxRetries: 3,
			delayMs: 1_500,
			code: 'overloaded',
			serverDirected: false,
		} as SessionEvent)

		const status = (mapped as { status?: { state?: string; message?: unknown } })?.status
		expect(status?.state).toBe('running')
		expect(JSON.stringify(status?.message)).toContain('attempt 2 of 3')
	})

	it('parks the task as input-required when a question is raised', () => {
		// A peer polling a task needs to know the difference between slow
		// and waiting-on-a-human; only one of them will ever finish on its
		// own.
		const mapped = map({
			type: 'user_question_asked',
			sessionId: SID,
			turnId: TID,
			checkpointId: fixtureId.checkpoint('1'),
			questionId: 'call_1:env',
			question: 'which environment?',
		} as SessionEvent)

		const status = (mapped as { status?: { state?: string; message?: unknown } })?.status
		expect(status?.state).toBe('input-required')
		expect(JSON.stringify(status?.message)).toContain('which environment?')
	})

	it('sends a failure classification as data, not as prose', () => {
		// A peer deciding whether to retry needs the code and the retryable
		// flag, not a sentence it would have to pattern-match.
		const mapped = map({
			type: 'turn_failed',
			sessionId: SID,
			turnId: TID,
			error: 'the model call failed',
			failure: {
				code: 'rate_limit',
				message: 'the provider is rate limiting',
				retryable: true,
				details: { status: 429 },
			},
			settlement: {
				status: 'failed',
				iterations: 1,
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: {
					inputCostPer1M: 0,
					outputCostPer1M: 0,
					totalCost: 0,
					cacheDiscount: 0,
					unpricedTokens: 0,
				},
				durationMs: 0,
				resultSource: 'model',
				abandonedTaskIds: [],
				abandonedJobIds: [],
			},
		} as SessionEvent)

		const text = JSON.stringify(mapped)
		expect(text).toContain('rate_limit')
		expect(text).toContain('retryable')
	})

	it('refuses a message role it has no mapping for', () => {
		// The exhaustiveness guard: a new role added to the union without a
		// mapping here must fail loudly rather than crossing the wire as
		// something a peer will misread.
		expect(() => messageToA2A({ role: 'nonsense', content: 'x' } as never)).toThrow(
			/Unhandled message role/,
		)
	})
})
