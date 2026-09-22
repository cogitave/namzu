import { describe, expect, it } from 'vitest'

import { MockLLMProvider, registerMock } from '../../provider/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import { runAgent } from '../runAgent.js'

/**
 * `completed` is not `succeeded`.
 *
 * `turn_failed` is emitted from exactly one place — the throw path in
 * `result.ts` — so every other way a turn can end badly arrives as
 * `turn_completed`: the token budget, the timeout, the iteration cap, a
 * cancellation, and a blocking output guardrail. A consumer reading that event
 * as success reported one for a turn whose answer was refused, and the CLI did:
 * it mapped the completion event to a bare `done` and exited 0.
 *
 * Measured before the fix: a `max_iterations` stop reports
 * `status: 'completed'`, and the event carried nothing to distinguish it.
 */

registerMock()

async function eventsOf(options: Parameters<typeof runAgent>[0]): Promise<SessionEvent[]> {
	const events: SessionEvent[] = []
	await runAgent({ ...options, listener: (e) => void events.push(e) })
	return events
}

function completion(
	events: SessionEvent[],
): Extract<SessionEvent, { type: 'turn_completed' }> | undefined {
	return events.find((e) => e.type === 'turn_completed') as never
}

describe('turn_completed says why the turn stopped', () => {
	it('reports end_turn when the model finished its answer', async () => {
		const events = await eventsOf({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			model: 'mock-model',
			prompt: 'x',
		})

		expect(completion(events)?.stopReason).toBe('end_turn')
	})

	it('reports max_iterations when the loop was cut short', async () => {
		const events = await eventsOf({
			provider: new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'absent', args: {} }] }] }),
			model: 'mock-model',
			prompt: 'x',
			maxIterations: 1,
		})

		const done = completion(events)
		// The event that a consumer treats as "the turn ended" — and the field
		// that stops it being read as "the turn succeeded".
		expect(done).toBeDefined()
		expect(done?.stopReason).toBe('max_iterations')
		expect(events.some((e) => e.type === 'turn_failed')).toBe(false)
	})
})
