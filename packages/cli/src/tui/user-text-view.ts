/**
 * How a message the person sent is echoed in the conversation.
 *
 * It is shown whole up to {@link USER_TEXT_LIMIT} characters, pasted text
 * included (the model always receives all of it). A longer message shows its
 * first and last {@link USER_TEXT_EDGE} characters with a divider between that
 * names how much is out of sight: `(12 lines, ~34 KB hidden)`.
 */

/** A message longer than this is cut when echoed. */
export const USER_TEXT_LIMIT = 10_000
/** Characters kept at each end of a cut message. */
export const USER_TEXT_EDGE = 2_500

export interface CutUserText {
	readonly head: string
	readonly tail: string
	readonly hiddenLines: number
	readonly hiddenChars: number
}

function newlines(text: string): number {
	let count = 0
	for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1
	return count
}

/** Index to cut at without splitting a surrogate pair. */
function safeEnd(text: string, end: number): number {
	const last = text.charCodeAt(end - 1)
	return end > 0 && last >= 0xd800 && last <= 0xdbff ? end - 1 : end
}

/** The text itself when it fits, otherwise its two ends and what lies between. */
export function cutUserText(text: string): string | CutUserText {
	if (text.length <= USER_TEXT_LIMIT) return text
	const head = text.slice(0, safeEnd(text, USER_TEXT_EDGE))
	let from = text.length - USER_TEXT_EDGE
	const first = text.charCodeAt(from)
	if (first >= 0xdc00 && first <= 0xdfff) from += 1
	const tail = text.slice(from)
	const hidden = text.slice(head.length, from)
	return {
		head,
		tail,
		hiddenLines: newlines(hidden),
		hiddenChars: hidden.length,
	}
}

/** `(12 lines, ~34 KB hidden)`, `(1 line, ~2 KB hidden)` or, with no line break in it, `(~34 KB hidden)`. */
export function hiddenTextNote(cut: Pick<CutUserText, 'hiddenLines' | 'hiddenChars'>): string {
	const kb = Math.max(1, Math.round(cut.hiddenChars / 1000)).toLocaleString('en-US')
	if (cut.hiddenLines === 0) return `(~${kb} KB hidden)`
	const lines = cut.hiddenLines.toLocaleString('en-US')
	return `(${lines} ${cut.hiddenLines === 1 ? 'line' : 'lines'}, ~${kb} KB hidden)`
}

/** The divider row: four rules, the note, then rules out to `width` cells. */
export function hiddenTextRule(note: string, width: number): string {
	const lead = '──── '
	const fill = Math.max(0, width - lead.length - note.length - 1)
	return `${lead}${note} ${'─'.repeat(fill)}`
}
