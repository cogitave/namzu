import type { AssistantMessage, Message, ToolMessage } from '../types/message/index.js'

/**
 * Which messages compaction may not evict or clear.
 *
 * The retention floor was entirely POSITIONAL: the leading system run, the
 * working-memory slot, the last N turns, the most recent tool results.
 * Every one of those is "whatever happens to be at an end of the
 * transcript", so a constraint stated in the MIDDLE of a conversation —
 * "the account id is X, never bill a different one" — aged out at the same
 * rate as chatter. The working-memory slot cannot express it either: that
 * is host-rendered per turn and does not know what the user said.
 *
 * `retain` says it directly. The cost of the marker is paid by whoever
 * sets it: pinned turns are exempt from the reclaim that keeps a long run
 * alive, so pinning the whole history is a way to make compaction useless.
 * Nothing here enforces a ceiling — a limit would have to guess which pin
 * mattered, and dropping the wrong one silently is worse than the run
 * overflowing loudly.
 */

const isAssistantWithCalls = (m: Message): m is AssistantMessage =>
	m.role === 'assistant' && Array.isArray((m as AssistantMessage).toolCalls)

/**
 * Indices of every message protected by a `retain` marker, expanded across
 * tool pairs.
 *
 * Transitive by necessity, not politeness. A `tool_result` whose
 * `tool_use` was dropped is rejected by the provider outright, so pinning
 * half a pair would turn a retention request into a broken next turn. So:
 * a pinned tool result pulls in the assistant turn that issued the call,
 * and a pinned assistant turn pulls in EVERY result answering it — the
 * second hop matters, because an assistant turn with three calls and one
 * surviving result is the same dangling error in the other direction.
 */
export function findRetainedIndices(messages: readonly Message[]): Set<number> {
	const retained = new Set<number>()
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.retain === true) retained.add(i)
	}
	if (retained.size === 0) return retained

	const assistantOfCall = new Map<string, number>()
	const resultsOfAssistant = new Map<number, number[]>()

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message || !isAssistantWithCalls(message)) continue
		for (const call of message.toolCalls ?? []) {
			assistantOfCall.set(call.id, i)
		}
	}
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (!message || message.role !== 'tool') continue
		const owner = assistantOfCall.get((message as ToolMessage).toolCallId)
		if (owner === undefined) continue
		const siblings = resultsOfAssistant.get(owner)
		if (siblings) siblings.push(i)
		else resultsOfAssistant.set(owner, [i])
	}

	// Worklist rather than one pass: pulling in an assistant turn adds
	// results that were not marked, and each of those would otherwise have
	// to be re-examined by hand.
	const pending = [...retained]
	while (pending.length > 0) {
		const index = pending.pop()
		if (index === undefined) continue
		const message = messages[index]
		if (!message) continue

		const add = (candidate: number | undefined) => {
			if (candidate === undefined || retained.has(candidate)) return
			retained.add(candidate)
			pending.push(candidate)
		}

		if (message.role === 'tool') {
			add(assistantOfCall.get((message as ToolMessage).toolCallId))
		}
		for (const sibling of resultsOfAssistant.get(index) ?? []) {
			add(sibling)
		}
	}

	return retained
}
