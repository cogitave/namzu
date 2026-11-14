import type { TranscriptMessage } from './types.js'

/**
 * Whether a row is the reply's own text: an assistant row drawn with the role's
 * default mark, holding words (or parts already printed while it streamed).
 */
function isReplyText(message: TranscriptMessage): boolean {
	return (
		message.role === 'assistant' &&
		message.glyph === undefined &&
		(message.content !== '' || (message.printed?.length ?? 0) > 0)
	)
}

/** A row that starts a new turn: something the person said, or the line that closes a turn. */
function opensTurn(message: TranscriptMessage): boolean {
	return message.role === 'user' || (message.role === 'system' && message.glyph === '✻')
}

/**
 * For each row, whether it is a later text block of a reply that already
 * showed its mark.
 *
 * A reply is every piece of text the model writes between two turn boundaries,
 * with its tool calls in between. Only the first text block carries the round
 * mark; the later ones start in the same text column and leave the mark column
 * blank. Tool rows and the rows around them neither carry nor reset it.
 */
export function laterReplyBlocks(messages: readonly TranscriptMessage[]): boolean[] {
	let marked = false
	return messages.map((message) => {
		if (opensTurn(message)) {
			marked = false
			return false
		}
		if (!isReplyText(message)) return false
		const later = marked
		marked = true
		return later
	})
}
