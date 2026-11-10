/**
 * Text measured in terminal cells.
 *
 * A column on the screen is a cell, not a character: a CJK letter or an emoji
 * takes two, a combining mark none. Selection, search highlights and copy all
 * speak in cells, so every conversion between a string and a column is here,
 * over user-perceived characters (graphemes) and the width helper the rest of
 * the interface measures with.
 */

import stringWidth from 'string-width'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface Cell {
	readonly text: string
	/** Where it starts, in cells. */
	readonly at: number
	readonly width: number
	/** Where it starts, in UTF-16 units of the string. */
	readonly offset: number
}

const memo = new Map<string, readonly Cell[]>()
const MEMO_LIMIT = 2_000

/** The characters of `text` with the cells they occupy. */
export function cellsOf(text: string): readonly Cell[] {
	const hit = memo.get(text)
	if (hit) return hit
	const cells: Cell[] = []
	let at = 0
	for (const { segment, index } of segmenter.segment(text)) {
		const width = stringWidth(segment)
		cells.push({ text: segment, at, width, offset: index })
		at += width
	}
	if (memo.size >= MEMO_LIMIT) memo.clear()
	memo.set(text, cells)
	return cells
}

/** Cells `text` takes. */
export function widthOf(text: string): number {
	const cells = cellsOf(text)
	const last = cells.at(-1)
	return last ? last.at + last.width : 0
}

/** The characters whose first cell is in `[from, to)`: a wide one is never cut in half. */
export function sliceCells(text: string, from: number, to: number): string {
	let out = ''
	for (const cell of cellsOf(text)) {
		if (cell.at >= to) break
		if (cell.at >= from) out += cell.text
	}
	return out
}

/** The cell range `[from, to)` that the UTF-16 range `[start, end)` of `text` covers. */
export function cellRangeOf(text: string, start: number, end: number): readonly [number, number] {
	let from = -1
	let to = 0
	for (const cell of cellsOf(text)) {
		const stop = cell.offset + cell.text.length
		if (stop <= start) continue
		if (cell.offset >= end) break
		if (from < 0) from = cell.at
		to = cell.at + cell.width
	}
	return [Math.max(from, 0), to]
}
