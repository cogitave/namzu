import type { Message } from '@namzu/sdk'

import type { AgentEvent } from './agent.js'

/**
 * Send a turn, and when the kernel refuses the screen's copy of the history
 * (`stale_cached_history`: it names a message the saved conversation never
 * gave out, or changed one) rebuild the copy from the saved conversation and
 * send once more. The saved log is the truth; the copy is only a cache of it.
 * A second refusal, or a conversation with nothing saved to rebuild from, is
 * passed on as the failure it is.
 */
export async function* sendWithRebuiltHistory(
	send: (prior: readonly Message[]) => AsyncIterable<AgentEvent>,
	input: {
		readonly history: readonly Message[]
		/** What this turn adds after the history: the person's message and any file context. */
		readonly tail: readonly Message[]
		readonly rebuild: () => Promise<readonly Message[] | undefined>
	},
): AsyncGenerator<AgentEvent> {
	let prior: readonly Message[] = [...input.history, ...input.tail]
	for (let attempt = 0; ; attempt += 1) {
		let refused: AgentEvent | undefined
		for await (const event of send(prior)) {
			if (
				attempt === 0 &&
				event.kind === 'error' &&
				event.failure?.code === 'stale_cached_history'
			) {
				refused = event
				break
			}
			yield event
		}
		if (!refused) return
		const fresh = await input.rebuild().catch(() => undefined)
		if (!fresh) {
			yield refused
			return
		}
		prior = [...fresh, ...input.tail]
	}
}
