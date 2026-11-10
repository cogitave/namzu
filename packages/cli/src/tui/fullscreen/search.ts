/**
 * Searching the transcript: what matches, which one is current, and the one
 * line the query is typed on. Pure functions over rows, so every step is driven
 * without a terminal.
 *
 * A match lies inside one row. A phrase the wrap split across two rows is not
 * found; the alternative, matching the unwrapped text, would put a highlight on
 * two rows from one match and make "next" ambiguous. Case is ignored unless the
 * query has a capital letter.
 */

import { eraseLastChoiceGrapheme } from '../terminal-choice-text.js'
import { cellsOf, widthOf } from './cells.js'
import type { FsRow } from './rows.js'

export interface Match {
	/** Index into the rows. */
	readonly row: number
	/** Cells `[from, to)` of that row's text. */
	readonly from: number
	readonly to: number
}

/** Whether the query is matched without regard to case. */
export function ignoresCase(query: string): boolean {
	return query === query.toLowerCase()
}

/** Every match of `query` in `rows`, in reading order. Empty for an empty query. */
export function findMatches(rows: readonly FsRow[], query: string): Match[] {
	if (query.length === 0) return []
	const loose = ignoresCase(query)
	const needle = loose ? query.toLowerCase() : query
	const found: Match[] = []
	rows.forEach((row, index) => {
		if (row.text.length === 0) return
		// Lowering one character at a time keeps every offset where it was.
		const cells = cellsOf(row.text)
		let haystack = ''
		const starts: number[] = []
		for (const cell of cells) {
			starts.push(haystack.length)
			haystack += loose ? cell.text.toLowerCase() : cell.text
		}
		let from = haystack.indexOf(needle)
		while (from >= 0) {
			const end = from + needle.length
			let first = 0
			while (first + 1 < starts.length && (starts[first + 1] as number) <= from) first += 1
			let last = first
			while (last + 1 < cells.length && (starts[last + 1] as number) < end) last += 1
			const a = cells[first]
			const b = cells[last]
			if (a && b && b.at + b.width > a.at)
				found.push({ row: index, from: a.at, to: b.at + b.width })
			from = haystack.indexOf(needle, Math.max(end, from + 1))
		}
	})
	return found
}

/**
 * The match to show first: the nearest one at or above `bottom` (the row at the
 * bottom edge of the window), else the nearest below it. -1 when there are none.
 */
export function startMatch(matches: readonly Match[], bottom: number): number {
	if (matches.length === 0) return -1
	let above = -1
	for (let i = 0; i < matches.length; i++) if ((matches[i] as Match).row <= bottom) above = i
	return above >= 0 ? above : 0
}

/** Step to the next (`1`) or previous (`-1`) match, wrapping round at either end. */
export function stepMatch(count: number, current: number, direction: 1 | -1): number {
	if (count === 0) return -1
	if (current < 0) return direction === 1 ? 0 : count - 1
	return (current + direction + count) % count
}

export interface SearchState {
	readonly query: string
}

/** What a key does to the query line. */
export type SearchEdit =
	| { readonly kind: 'query'; readonly query: string }
	| { readonly kind: 'next' }
	| { readonly kind: 'previous' }
	| { readonly kind: 'close' }
	| { readonly kind: 'none' }

interface SearchKey {
	readonly return?: boolean
	readonly shift?: boolean
	readonly meta?: boolean
	readonly ctrl?: boolean
	readonly escape?: boolean
	readonly backspace?: boolean
	readonly delete?: boolean
	readonly upArrow?: boolean
	readonly downArrow?: boolean
}

/**
 * What one key press does while the search line is open. Enter and the down
 * arrow go to the next match, Shift+Enter, Alt+Enter and the up arrow to the
 * previous; Escape closes; anything printable is part of the query.
 */
export function editSearch(query: string, input: string, key: SearchKey): SearchEdit {
	if (key.escape) return { kind: 'close' }
	if (key.return) return key.shift || key.meta ? { kind: 'previous' } : { kind: 'next' }
	if (key.downArrow) return { kind: 'next' }
	if (key.upArrow) return { kind: 'previous' }
	if (key.backspace || key.delete) return { kind: 'query', query: eraseLastChoiceGrapheme(query) }
	if (key.ctrl || key.meta) return { kind: 'none' }
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are not text
	const text = input.replace(/[\u0000-\u001f\u007f]/gu, '')
	return text.length > 0 ? { kind: 'query', query: query + text } : { kind: 'none' }
}

/** The last `max` cells of `text`: a long query shows its end, where it is being typed. */
function tail(text: string, max: number): string {
	const cells = cellsOf(text)
	const total = widthOf(text)
	if (total <= max) return text
	const keep = cells.filter((cell) => cell.at >= total - Math.max(1, max - 1))
	return `…${keep.map((cell) => cell.text).join('')}`
}

/**
 * The search line: what is typed, which match is current, and the keys, in the
 * longest form that fits `columns` cells. `current` counts from 0, -1 for none.
 */
export function searchLine(query: string, current: number, count: number, columns: number): string {
	const status = query.length === 0 ? '' : count === 0 ? 'No matches' : `${current + 1}/${count}`
	const forms = [
		`Find: ${query}▏  ${status}  ↵ next · ⇧↵ previous · esc close`,
		`Find: ${query}▏  ${status}  ↵ next · esc close`,
		`Find: ${query}▏  ${status}`,
		`${query}▏ ${status}`,
	].map((form) => form.replace(/ {3,}/gu, '  ').replace(/ +$/u, ''))
	for (const form of forms) if (widthOf(form) <= columns) return form
	const room = Math.max(1, columns - widthOf(`Find: ▏  ${status}`))
	return `Find: ${tail(query, room)}▏  ${status}`.trimEnd()
}
