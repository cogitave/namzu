/**
 * How the terminal says that text is folded away, in one place.
 *
 * A folded body ends in `… +12 lines (ctrl+o to expand)`, with ` (~3 KB)` after
 * it when at least 1,000 characters are out of sight, so a person can tell a
 * few lines from a wall of text before opening it. Every collapsed body (tool
 * output, a shell cell, an agent's answer) uses this and no other wording.
 */

/** The one phrase that tells a person a folded body can be opened. */
export const EXPAND_HINT = '(ctrl+o to expand)'

/** Hidden text is sized once it reaches this many characters. */
export const HIDDEN_SIZE_FROM_CHARS = 1000

export interface HiddenHintOptions {
	/** Characters out of sight; sizes the hint from 1,000 up. */
	readonly chars?: number
	/** False when nothing can open the body, so the hint does not promise it. Default true. */
	readonly canExpand?: boolean
}

/** `… +N lines (ctrl+o to expand)`; `line` when exactly one is folded. */
export function hiddenLinesHint(lines: number, options: HiddenHintOptions = {}): string {
	const noun = lines === 1 ? 'line' : 'lines'
	const action = options.canExpand === false ? '' : ` ${EXPAND_HINT}`
	const size =
		options.chars !== undefined && options.chars >= HIDDEN_SIZE_FROM_CHARS
			? ` (~${Math.max(1, Math.round(options.chars / 1024)).toLocaleString('en-US')} KB)`
			: ''
	return `… +${lines.toLocaleString('en-US')} ${noun}${action}${size}`
}

/**
 * `text` cut to at most `max` UTF-16 units, ending in an ellipsis, without ever
 * splitting a surrogate pair: a lone half of an emoji is not valid text and
 * breaks whatever reads the transcript back.
 */
export function clipText(text: string, max: number): string {
	if (text.length <= max) return text
	const room = Math.max(0, max - 1)
	let end = room
	const last = text.charCodeAt(end - 1)
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
	return `${text.slice(0, end)}…`
}
