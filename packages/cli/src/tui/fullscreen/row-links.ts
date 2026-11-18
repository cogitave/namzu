/**
 * Links in the rows of the window.
 *
 * A line the wrap cut into rows is one line again here (the rows say how they were joined), so an
 * address that ran over the edge is one link, and each of its rows underlines. Positions are cells
 * of a row's text, the unit the pointer reports and the marks are painted in.
 */

import type { FoundLink, LinkSpan } from '../links.js'
import { cellsOf } from './cells.js'
import type { FsRow } from './rows.js'

/** Cells `[from, to)` of one row that a link covers. */
export interface LinkPiece {
	readonly row: number
	readonly from: number
	readonly to: number
}

export interface RowLink {
	readonly link: FoundLink
	/** Same for every piece of the link: the first row and cell it starts at. */
	readonly id: string
	readonly pieces: readonly LinkPiece[]
}

/** Finds the links in a line of text. */
export type FindLinks = (text: string) => readonly LinkSpan[]

/** The rows `[start, end]` that were one line before the wrap, around `row`. */
function logicalRange(rows: readonly FsRow[], row: number): readonly [number, number] {
	let start = row
	while (start > 0 && (rows[start]?.joins ?? null) !== null) start--
	let end = row
	while (end + 1 < rows.length && (rows[end + 1]?.joins ?? null) !== null) end++
	return [start, end]
}

interface Segment {
	readonly row: number
	/** Where the row's text starts in the joined line. */
	readonly at: number
	/** Where the row's own text starts in the row's string (a hanging indent is not text). */
	readonly offset: number
}

/** The links on the line `row` belongs to, with the cells each covers on each of its rows. */
export function linksOnLine(
	rows: readonly FsRow[],
	row: number,
	find: FindLinks,
): readonly RowLink[] {
	if (rows[row] === undefined || rows[row]?.mark !== undefined) return []
	const [start, end] = logicalRange(rows, row)
	let joined = ''
	const segments: Segment[] = []
	for (let i = start; i <= end; i++) {
		const r = rows[i] as FsRow
		const continued = i > start
		if (continued) joined += r.joins ?? ''
		const lead = continued ? r.lead : 0
		const first = cellsOf(r.text).find((cell) => cell.at >= lead)
		const offset = first?.offset ?? r.text.length
		segments.push({ row: i, at: joined.length, offset })
		joined += r.text.slice(offset)
	}
	const out: RowLink[] = []
	for (const span of find(joined)) {
		const pieces: LinkPiece[] = []
		segments.forEach((segment, i) => {
			const rowEnd = i + 1 < segments.length ? (segments[i + 1] as Segment).at : joined.length
			const from = Math.max(span.from, segment.at)
			const to = Math.min(span.to, rowEnd)
			if (to <= from) return
			const text = (rows[segment.row] as FsRow).text
			const cells = cellsOf(text)
			const inRow = (u: number): number => {
				const unit = u - segment.at + segment.offset
				const cell = cells.find((c) => c.offset >= unit)
				return cell ? cell.at : (cells.at(-1)?.at ?? 0) + (cells.at(-1)?.width ?? 0)
			}
			pieces.push({ row: segment.row, from: inRow(from), to: inRow(to) })
		})
		const head = pieces[0]
		if (head) out.push({ link: span.link, id: `${head.row}:${head.from}`, pieces })
	}
	return out
}

/** The link under cell `col` of `row`, if any. */
export function linkAt(
	rows: readonly FsRow[],
	row: number,
	col: number,
	find: FindLinks,
): RowLink | null {
	for (const found of linksOnLine(rows, row, find)) {
		if (found.pieces.some((p) => p.row === row && col >= p.from && col < p.to)) return found
	}
	return null
}
