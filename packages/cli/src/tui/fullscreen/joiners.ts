/**
 * What a wrap took out of a line, found again from the line and its rows.
 *
 * A wrapper drops the space it breaks at and adds no mark where it cuts a word,
 * so a copy that glues the rows back together has to know which it was. The
 * answer is in the source: walk it past the characters each row shows, and look
 * at what lies before the next row's first one. Whitespace is read loosely on
 * both sides (a wrapper collapses runs of it), so only the visible characters
 * are matched.
 */

import { terminalDisplayText } from '../terminal-display.js'
import type { Joiner } from './rows.js'

const BLANK = /^\s$/u

/**
 * For each of `rows` (the wrap of `source`, in order), how it joins the one
 * before: null for a row that starts a source line, and for an empty row.
 */
export function wrapJoiners(source: string, rows: readonly string[]): (Joiner | null)[] {
	const text = [...terminalDisplayText(source)]
	let at = 0
	let seenFirst = false
	return rows.map((row) => {
		const shown = [...row].filter((ch) => !BLANK.test(ch)).length
		if (shown === 0) return null
		let gap = ''
		while (at < text.length && BLANK.test(text[at] as string)) gap += text[at++]
		let left = shown
		while (at < text.length && left > 0) {
			if (!BLANK.test(text[at] as string)) left -= 1
			at += 1
		}
		const first = !seenFirst
		seenFirst = true
		if (first || gap.includes('\n')) return null
		return gap.length > 0 ? ' ' : ''
	})
}
