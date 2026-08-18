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
 * the readable `@file` token before App expands it for the model. `/clear` can
 * remove an arbitrary prefix of transcript rows, and compaction can do the same,
 * so the two lists are paired from the newest end rather than by index zero.
 * A durable user with no surviving row falls back to the exact model-visible
 * content instead of being omitted from the editor.
 */
export function editablePrompts(
	history: readonly Message[],
	transcript: readonly TranscriptMessage[],
): readonly EditablePrompt[] {
	const users = history.filter((message): message is UserMessage => message.role === 'user')
	const visible = transcript.filter((message) => message.role === 'user')
	const paired = Math.min(users.length, visible.length)
	const durableStart = users.length - paired
	const visibleStart = visible.length - paired

	return users.map((message, userOrdinal) => {
		const visibleIndex = visibleStart + (userOrdinal - durableStart)
		const row = userOrdinal >= durableStart ? visible[visibleIndex] : undefined
		return {
			userOrdinal,
			message,
			displayText: row?.content ?? message.content,
		}
	})
}
