/**
 * Where a hint such as `(ctrl+o to expand)` lands when its row has to wrap.
 *
 * A hint is one thing a person reads at a glance. Wrapped like prose, a
 * narrow terminal split it across two rows and left one word of it alone on
 * the second. The rule, for every row that carries one, in both screens:
 *
 *   1. It fits after the text on the row's last line: nothing changes.
 *   2. It does not, but it fits a row of its own: it moves there whole, in
 *      the column the text continues in, and the separator before it is left
 *      off (a row never ends in a dangling `·`).
 *   3. It does not fit a row at all: its short form (`(ctrl+o)`, `(click)`)
 *      stands in, when there is one and it fits.
 *   4. Nothing fits: it is left off. The row can still be opened.
 *
 * Pure; unit-tested.
 */

import { choiceDisplayWidth as terminalCellWidth, wrapChoiceText } from './terminal-choice-text.js'
import { CLICK_EXPAND_HINT, CLICK_FOLD_HINT, EXPAND_HINT } from './truncation.js'

/** The hints this applies to, and the shorter form each one has. */
const HINTS: readonly (readonly [full: string, short: string | undefined])[] = [
	[EXPAND_HINT, '(ctrl+o)'],
	[CLICK_EXPAND_HINT, '(click)'],
	[CLICK_FOLD_HINT, undefined],
]

/** How `text` breaks into rows `width` cells wide. */
export type HintWrap = (text: string, width: number) => readonly string[]

/** The size note a folded body's hint may carry after it: ` (~3 KB)`. */
const SIZE_NOTE = / \(~[\d,]+ KB\)$/u

/**
 * Where `text` ends in one of the hints, and the hint, its short form and the
 * size note that may follow it (which stays with it).
 */
function trailingHint(text: string):
	| {
			readonly hint: string
			readonly short: string | undefined
			readonly note: string
			readonly at: number
	  }
	| undefined {
	const note = SIZE_NOTE.exec(text)?.[0] ?? ''
	const body = note.length > 0 ? text.slice(0, -note.length) : text
	for (const [full, short] of HINTS) {
		if (body.endsWith(full)) return { hint: full, short, note, at: body.length - full.length }
	}
	return undefined
}

/** True when `text` ends in one of the expand or fold hints. */
export function endsInHint(text: string): boolean {
	return trailingHint(text) !== undefined
}

/**
 * `text` (which ends in a hint, or is returned as it is) arranged so the hint
 * is never cut across rows when `text` is wrapped to `width` cells by `wrap`.
 * When the hint fits where it is, the result is `text` itself, to the cell.
 */
export function fitHint(text: string, width: number, wrap: HintWrap): string {
	const found = trailingHint(text)
	if (found === undefined) return text
	const lead = text.slice(0, found.at)
	const sep = /( · | )$/u.exec(lead)?.[0]
	// Alone on its row, or after a newline already: nothing to move.
	if (sep === undefined) return text
	const before = lead.slice(0, -sep.length)
	const unit = `${found.hint}${found.note}`
	const rows = wrap(before, width)
	const last = rows.at(-1) ?? ''
	if (terminalCellWidth(last) + terminalCellWidth(sep) + terminalCellWidth(unit) <= width) {
		return text
	}
	if (terminalCellWidth(unit) <= width) return `${before}\n${unit}`
	const short = found.short === undefined ? undefined : `${found.short}${found.note}`
	if (short !== undefined && terminalCellWidth(short) <= width) return `${before}\n${short}`
	return before
}

/** `fitHint` measured the way the plain-text screens wrap. */
export function fitHintPlain(text: string, width: number): string {
	return fitHint(text, width, wrapChoiceText)
}

/**
 * What goes after `before` where `tail` (a separator and then the text that
 * ends in a hint) would: `tail` itself when it fits, a newline and the hint
 * when it does not, the short form, or nothing.
 */
export function hintSuffix(before: string, tail: string, width: number): string {
	return fitHintPlain(`${before}${tail}`, width).slice(before.length)
}
