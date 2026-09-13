import { isDeepStrictEqual } from 'node:util'
import {
	type AssistantMessage,
	type AssistantTextPart,
	type Message,
	isCompactionMessage,
	selectAssistantText,
} from '@namzu/sdk'

/** Public display text only. Never rewrite durable history or inspect private replay state. */
export function assistantTranscriptTexts(message: AssistantMessage): readonly string[] {
	const content = typeof message.content === 'string' ? message.content : ''
	const parts = message.textParts
	const valid =
		Array.isArray(parts) &&
		parts.every(
			(part): part is AssistantTextPart =>
				part !== null &&
				typeof part === 'object' &&
				typeof part.id === 'string' &&
				typeof part.text === 'string' &&
				(part.phase === undefined || part.phase === 'commentary' || part.phase === 'final_answer'),
		)
	// Compaction or editing may have changed content without keeping the old
	// public parts aligned. Do not bring superseded text back onto the screen.
	const texts =
		valid && selectAssistantText(parts) === content ? parts.map((part) => part.text) : [content]
	return texts.filter((text) => text.trim().length > 0)
}

/**
 * The part of a settled SDK run that belongs to the host-owned conversation.
 *
 * `Run.messages` is deliberately wider: a fresh query prepends its current
 * cached + dynamic system floor before it replays the host's messages. Those
 * instructions are request context, not conversation history, and persisting
 * them would leak identity/environment/project/skill text into `/resume` while
 * duplicating a floor the next query rebuilds anyway.
 *
 * Compaction summaries are different. They are system-role messages too, but
 * they are the only surviving representation of conversation turns the kernel
 * shed, and the fresh-run seeder recognises the same header and replays them.
 */
export function projectRunConversation(messages: readonly Message[]): readonly Message[] {
	return messages.filter(
		(message) => message.role !== 'system' || isCompactionMessage(message.content),
	)
}

export type TurnPublication =
	| { readonly kind: 'append'; readonly messages: readonly Message[] }
	| { readonly kind: 'replace'; readonly messages: readonly Message[] }

/**
 * Publish one settled turn without inventing model state or tearing a tool turn.
 *
 * The store already contains `prior`; `user` is the new input. A plain
 * assistant tail is safe to append after that user: a crash between the two
 * leaves a complete user turn. A structural tail is one transaction instead —
 * splitting assistant(tool-call) from tool(result), or one automatic
 * continuation from the next, would leave a provider-invalid projection.
 */
export function planTurnPublication(
	prior: readonly Message[],
	user: Message,
	projected: readonly Message[],
): TurnPublication {
	const input = [...prior, user]
	const preservesInput =
		projected.length >= input.length &&
		input.every((message, index) => isDeepStrictEqual(projected[index], message))

	if (!preservesInput) return { kind: 'replace', messages: projected }

	const tail = projected.slice(input.length)
	const structuralTail =
		tail.length > 1 ||
		tail.some(
			(message) =>
				message.role !== 'assistant' ||
				(message.toolCalls !== undefined && message.toolCalls.length > 0),
		)
	return structuralTail
		? { kind: 'replace', messages: projected }
		: { kind: 'append', messages: [user, ...tail] }
}
