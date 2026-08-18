import type { Message, UserMessage } from '@namzu/sdk'

import type { TranscriptMessage } from './types.js'

/** One durable branch boundary, plus the best text the composer can restore. */
export interface EditablePrompt {
	/** Zero-based among durable user messages. */
	readonly userOrdinal: number
	readonly message: UserMessage
	/** Readable operator text when the current transcript still has it. */
	readonly displayText: string
}

/**
 * Pair durable user messages with the visible transcript's user-row suffix.
 *
 * Durable history is the authority for where a fork may occur and for every
 * attachment. The transcript alone keeps one useful value persistence cannot:
 * the readable `@file` token before App expands it for the model. `/clear-screen` can
 * remove an arbitrary prefix of transcript rows, and compaction can do the same,
 * so the two lists are paired from the newest end rather than by index zero.
 * A durable user with no surviving row falls back to the exact model-visible
 * content instead of being omitted from the editor.
 */
export function editablePrompts(
	history: readonly Message[],
	transcript: readonly TranscriptMessage[],
): readonly EditablePrompt[] {
	let durableUserOrdinal = 0
	const users = history.flatMap<{ readonly message: UserMessage; readonly userOrdinal: number }>(
		(message) => {
			if (message.role !== 'user') return []
			const userOrdinal = durableUserOrdinal
			durableUserOrdinal += 1
			return message.source?.type === 'goal-round' ? [] : [{ message, userOrdinal }]
		},
	)
	const visible = transcript.filter((message) => message.role === 'user')
	const paired = Math.min(users.length, visible.length)
	const durableStart = users.length - paired
	const visibleStart = visible.length - paired

	return users.map(({ message, userOrdinal }, index) => {
		const visibleIndex = visibleStart + (index - durableStart)
		const row = index >= durableStart ? visible[visibleIndex] : undefined
		return {
			userOrdinal,
			message,
			displayText: row?.content ?? message.content,
		}
	})
}
