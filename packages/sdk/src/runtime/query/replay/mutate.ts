import type { ToolCallId } from '../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	type ToolCall,
	createToolMessage,
} from '../../../types/message/index.js'
import { type Mutation, MutationNotApplicableError } from '../../../types/run/replay.js'

/**
 * Returns the tool calls on the most recent assistant message that do not
 * yet have a matching {@link import('../../../types/message/index.js').ToolMessage}
 * response further down the message list. These are the fork-point "pending"
 * tool calls that mutations may target.
 */
function findPendingToolCalls(messages: readonly Message[]): ToolCall[] {
	let lastAssistantIdx = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg && msg.role === 'assistant' && (msg.toolCalls?.length ?? 0) > 0) {
			lastAssistantIdx = i
			break
		}
	}
	if (lastAssistantIdx === -1) return []

	const assistant = messages[lastAssistantIdx] as AssistantMessage
	const satisfied = new Set<string>()
	for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
		const msg = messages[i]
		if (msg && msg.role === 'tool') {
			satisfied.add(msg.toolCallId)
		}
	}
	return (assistant.toolCalls ?? []).filter((tc) => !satisfied.has(tc.id))
}

/**
 * Apply an ordered list of {@link Mutation} to a checkpoint's message
 * history at the fork point, producing a new message array that the
 * resumed iteration loop consumes. Pure function; does not touch the run
 * store, does not emit events.
 *
 * Throws {@link MutationNotApplicableError} when an `injectToolResponse`
 * mutation targets a tool call id that is not pending at the fork point —
 * the error payload carries the list of ids that *are* pending so the
 * caller can recover without guessing.
 *
 * See ses_005-deterministic-replay design §3.3.
 */
export function applyMutations(
	messages: readonly Message[],
	mutations: readonly Mutation[],
): Message[] {
	let current: Message[] = [...messages]
	for (const m of mutations) {
		current = applyOne(current, m)
	}
	return current
}

function applyOne(messages: Message[], mutation: Mutation): Message[] {
	switch (mutation.type) {
		case 'injectToolResponse': {
			const pending = findPendingToolCalls(messages)
			const match = pending.find((tc) => tc.id === mutation.toolCallId)
			if (!match) {
				throw new MutationNotApplicableError(
					`No pending tool call ${mutation.toolCallId} at fork point`,
					pending.map((tc) => tc.id as ToolCallId),
				)
			}
			return [...messages, createToolMessage(mutation.response.output, mutation.toolCallId)]
		}
	}
}
