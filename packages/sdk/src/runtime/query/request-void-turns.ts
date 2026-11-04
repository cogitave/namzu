import type { Message } from '../../types/message/index.js'

/**
 * The provider-bound view of a conversation without assistant entries that
 * carry nothing at all: no text, no tool call, no reasoning, no citation.
 *
 * An empty reply (a refused or cut-off model, or a completion that produced
 * nothing) is recorded in the history, and the loop goes on to ask again, so
 * the next request would carry it. Chat Completions endpoints reject such an
 * entry ("content or tool_calls must be set"), and no wire gives it a meaning.
 * The stored history is never edited; only the request leaves it out.
 *
 * An entry that still holds reasoning stays: a driver whose wire replays signed
 * or native reasoning needs it, and each driver decides what a reasoning-only
 * entry looks like on its own wire. An entry with tool calls always stays, so a
 * tool result still follows the call it answers. Returns the original array
 * when nothing is dropped.
 */
export function withoutVoidAssistantTurns(messages: Message[]): Message[] {
	const isVoid = (message: Message): boolean =>
		message.role === 'assistant' &&
		!message.content &&
		(message.toolCalls?.length ?? 0) === 0 &&
		(message.reasoning?.length ?? 0) === 0 &&
		(message.citations?.length ?? 0) === 0 &&
		(message.textParts?.length ?? 0) === 0
	return messages.some(isVoid) ? messages.filter((message) => !isVoid(message)) : messages
}
