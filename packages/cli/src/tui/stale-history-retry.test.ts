import { createUserMessage } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from './agent.js'
import { sendWithRebuiltHistory } from './stale-history-retry.js'

const stale = {
	kind: 'error',
	message: 'refused',
	failure: { code: 'stale_cached_history', message: 'x', retryable: false },
} as AgentEvent
const done = { kind: 'done', stopReason: 'end_turn' } as AgentEvent

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = []
	for await (const event of source) out.push(event)
	return out
}

describe('sending with a rebuilt history', () => {
	const stalePrior = { ...createUserMessage('old'), id: 'foreign' } as unknown as Message
	const fresh = createUserMessage('old')
	const tail = [createUserMessage('new')]

	it('rebuilds from the saved conversation after a refusal and sends once more', async () => {
		const seen: (readonly Message[])[] = []
		const events = await collect(
			sendWithRebuiltHistory(
				async function* (prior) {
					seen.push(prior)
					yield seen.length === 1 ? stale : done
				},
				{ history: [stalePrior], tail, rebuild: async () => [fresh] },
			),
		)
		expect(events).toEqual([done])
		expect(seen).toEqual([
			[stalePrior, ...tail],
			[fresh, ...tail],
		])
	})

	it('passes a second refusal on and does not loop', async () => {
		let sends = 0
		const events = await collect(
			sendWithRebuiltHistory(
				async function* () {
					sends += 1
					yield stale
				},
				{ history: [stalePrior], tail, rebuild: async () => [fresh] },
			),
		)
		expect(events).toEqual([stale])
		expect(sends).toBe(2)
	})

	it('passes the refusal on when there is nothing saved to rebuild from', async () => {
		const events = await collect(
			sendWithRebuiltHistory(
				async function* () {
					yield stale
				},
				{ history: [stalePrior], tail, rebuild: async () => undefined },
			),
		)
		expect(events).toEqual([stale])
	})

	it('leaves an ordinary failure alone', async () => {
		let sends = 0
		const other = { kind: 'error', message: 'down' } as AgentEvent
		const events = await collect(
			sendWithRebuiltHistory(
				async function* () {
					sends += 1
					yield other
				},
				{ history: [], tail, rebuild: async () => [fresh] },
			),
		)
		expect(events).toEqual([other])
		expect(sends).toBe(1)
	})
})
