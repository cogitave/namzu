/**
 * Selecting text in the window with the pointer, and what a copy takes from it.
 *
 * A point is a row of the conversation and a cell of its text, so a selection
 * stays on its text while the view scrolls and while output arrives below it.
 * The word, line and range arithmetic is the workspaces screen's
 * (`workspaces/selection.ts`), read over these rows; what is here is the part
 * that is about rows: where a pointer report lands, and how rows are glued back
 * into the lines they were before they were wrapped.
 */

import {
	type Point,
	type Range,
	type TextSource,
	colsOnLine,
	lineAt,
	orderRange,
	snapRange,
	wordAt,
} from '../../workspaces/selection.js'
import { cellsOf, sliceCells } from './cells.js'
import type { FsRow } from './rows.js'

export type { Point, Range }

/** How far a drag reaches: by character, by word (double click) or by line (triple click). */
export type SelectMode = 'char' | 'word' | 'line'

export interface Selection {
	readonly anchor: Point
	readonly focus: Point
	readonly mode: SelectMode
}

/** The rows as the text source the shared selection code reads. */
export function rowsSource(rows: readonly FsRow[], cols: number): TextSource {
	const cellAt = (line: number, col: number) => {
		const cells = cellsOf(rows[line]?.text ?? '')
		// Binary search would do; rows are a screen wide at most.
		for (const cell of cells) {
			if (col >= cell.at && col < cell.at + Math.max(1, cell.width)) return cell
		}
		return undefined
	}
	return {
		cols,
		bufferLength: () => rows.length,
		lineText: (line, from, to) => sliceCells(rows[line]?.text ?? '', from, to),
		lineWrapped: (line) => (rows[line]?.joins ?? null) !== null,
		cellWidth(line, col) {
			const cell = cellAt(line, col)
			if (!cell) return 1
			return col === cell.at ? cell.width : 0
		},
	}
}

/** The range a selection covers once word and line modes have grown it. */
export function selectionRange(source: TextSource, selection: Selection): Range {
	const base = orderRange(selection.anchor, selection.focus)
	if (selection.mode === 'char') return snapRange(source, base)
	const grow = selection.mode === 'word' ? wordAt : lineAt
	const first = grow(source, base.start.line, base.start.col)
	const last = grow(source, base.end.line, base.end.col)
	return { start: first.start, end: last.end }
}

/** The cells of one row a range covers, within the width of its text; undefined when none. */
export function rowCells(
	range: Range,
	row: number,
	text: string,
	cols: number,
): readonly [number, number] | undefined {
	const covered = colsOnLine(range, row, cols)
	if (!covered) return undefined
	const cells = cellsOf(text)
	const last = cells.at(-1)
	const end = last ? last.at + last.width : 0
	const to = Math.min(covered[1], end)
	return to > covered[0] ? [covered[0], to] : undefined
}

/**
 * The text of a range: plain characters, no gutter and no styling. A row that
 * the wrap continued is joined to the one above it the way it was before the
 * wrap (the space it broke at, or nothing); a line of its own gets a line break.
 */
export function extractRows(rows: readonly FsRow[], cols: number, range: Range): string {
	let out = ''
	for (let line = range.start.line; line <= range.end.line; line++) {
		const row = rows[line]
		if (!row) break
		const covered = colsOnLine(range, line, cols)
		let text = ''
		if (covered) {
			// The hang indent of a continuation is layout, not text.
			const from = row.joins !== null ? Math.max(covered[0], row.lead) : covered[0]
			text = sliceCells(row.text, from, covered[1]).replace(/[ \t]+$/u, '')
		}
		if (line === range.start.line) out = text
		else out += (row.joins ?? '\n') + text
	}
	return out
}

/** The text a selection copies. */
export function selectedText(rows: readonly FsRow[], cols: number, selection: Selection): string {
	return extractRows(rows, cols, selectionRange(rowsSource(rows, cols), selection)).replace(
		/\n+$/u,
		'',
	)
}

/** Where the window sits on the screen, for turning a pointer report into a point. */
export interface Geometry {
	/** Screen row (1 is the top) of the window's first row. */
	readonly top: number
	/** Rows the window has, the one-line hint or search field included. */
	readonly height: number
	/** The rows drawn: `[from, to)`. */
	readonly from: number
	readonly to: number
	/** Rows under the last row of text: the jump hint or the search line. */
	readonly footer: number
	/** Screen column (1 is the left) of the first cell of text. */
	readonly left: number
	/** Cells of text a row has. */
	readonly cols: number
}

/** Where a pointer report landed: on a row, or beyond the window's top or bottom. */
export type Landing =
	| { readonly kind: 'on'; readonly point: Point }
	| { readonly kind: 'above'; readonly point: Point }
	| { readonly kind: 'below'; readonly point: Point }
	| { readonly kind: 'outside' }

export function landOn(g: Geometry, x: number, y: number): Landing {
	if (g.to <= g.from) return { kind: 'outside' }
	const bottom = g.top + g.height - 1
	const col = Math.min(Math.max(x - g.left, 0), Math.max(0, g.cols - 1))
	const row = g.to - 1 - (bottom - g.footer - y)
	if (y < g.top) return { kind: 'above', point: { line: g.from, col } }
	if (y > bottom) return { kind: 'outside' }
	if (row < g.from) return { kind: 'above', point: { line: g.from, col } }
	if (row >= g.to) return { kind: 'below', point: { line: g.to - 1, col } }
	return { kind: 'on', point: { line: row, col } }
}
