/**
 * A markdown table laid out for the terminal, as the reference terminal draws
 * one.
 *
 * ## Grid
 *
 * A box of one-cell-wide rule glyphs (`┌┬┐ ├┼┤ └┴┘ │ ─`), sized to the room
 * there is: each column gets its widest line when everything fits, and
 * otherwise at least its longest word, with the rest of the room shared in
 * proportion to how much more each column wanted. A cell too long for its
 * column wraps inside it, with its inline markdown — `**bold**`, `` `code` ``,
 * links — drawn, not shown as source. The header is bold and centred; body
 * cells take the separator row's alignment. A rule separates every row, so a
 * wrapped cell cannot be read as two rows.
 *
 * ## Stacked
 *
 * Below the width where the grid can hold every column's longest word, or
 * where a row would wrap to more than {@link MAX_ROW_LINES} lines, the table
 * is drawn as records instead: one `Header: value` line per column, wrapped to
 * the full width, records separated by a short `─` rule. A table squeezed into
 * a column a few characters wide is harder to read than the same facts as a
 * list.
 *
 * Widths are terminal cells (`string-width`), so CJK text and emoji keep the
 * box straight. Pure; unit-tested. `Markdown.tsx` draws the result.
 */

import {
	type DisplayLine,
	type DisplaySpan,
	displayWidth,
	inlineDisplaySpans,
	longestWordWidth,
	wrapSpans,
} from './markdown-wrap.js'
import type { TableAlign } from './markdownParser.js'

/** A row taller than this, in the grid, reads worse than the stacked form. */
export const MAX_ROW_LINES = 4

/** The longest word a column is widened to hold whole; longer ones break inside the cell. */
const MAX_UNBROKEN_WORD = 30

/** The rule between stacked records is at most this wide. */
const STACKED_RULE_MAX = 40

/** A drawn span, plus the two roles only a table has. */
export interface TableSpan extends DisplaySpan {
	/** Box-drawing glyphs and the stacked rule: drawn in the border colour. */
	readonly border?: boolean
	/** Header text: drawn bold. */
	readonly header?: boolean
}

export type TableLine = readonly TableSpan[]

export interface TableLayout {
	readonly mode: 'grid' | 'stacked'
	readonly lines: readonly TableLine[]
}

export interface TableSource {
	readonly headers: readonly string[]
	readonly rows: readonly (readonly string[])[]
	readonly align?: readonly TableAlign[]
}

/** Lay a table out in `width` terminal cells. */
export function layoutTable(
	table: TableSource,
	width: number,
	options: { readonly hyperlinks?: boolean } = {},
): TableLayout {
	const hyperlinks = options.hyperlinks === true
	const columns = Math.max(1, table.headers.length)
	const headers = Array.from({ length: columns }, (_, c) =>
		inlineDisplaySpans(table.headers[c] ?? '', hyperlinks).map((s) => ({ ...s, bold: true })),
	)
	const rows = table.rows.map((row) =>
		Array.from({ length: columns }, (_, c) => inlineDisplaySpans(row[c] ?? '', hyperlinks)),
	)
	const grid = gridLayout(headers, rows, table.align, width)
	return grid ?? { mode: 'stacked', lines: stackedLines(headers, rows, width) }
}

function gridLayout(
	headers: readonly DisplaySpan[][],
	rows: readonly DisplaySpan[][][],
	align: readonly TableAlign[] | undefined,
	width: number,
): TableLayout | undefined {
	const columns = headers.length
	// `│ a │ b │`: a rule before every column and after the last, and one
	// space of padding each side of every cell.
	const room = width - (3 * columns + 1)
	if (room < columns * 3) return undefined
	const all = [headers, ...rows]
	const want = Array.from({ length: columns }, (_, c) =>
		Math.max(1, ...all.map((row) => displayWidth(row[c] ?? []))),
	)
	// A word longer than this — a URL, a path — is broken inside its cell
	// rather than allowed to push the whole table into the stacked form.
	const least = Array.from({ length: columns }, (_, c) =>
		Math.min(MAX_UNBROKEN_WORD, Math.max(1, ...all.map((row) => longestWordWidth(row[c] ?? [])))),
	)
	const widths = columnWidths(want, least, room)
	if (!widths) return undefined

	const wrapRow = (row: readonly DisplaySpan[][]) =>
		widths.map((w, c) => wrapSpans(row[c] ?? [], w))
	const body = rows.map(wrapRow)
	if (body.some((cells) => Math.max(...cells.map((lines) => lines.length)) > MAX_ROW_LINES))
		return undefined

	const rule = (left: string, middle: string, right: string): TableLine => [
		{ text: `${left}${widths.map((w) => '─'.repeat(w + 2)).join(middle)}${right}`, border: true },
	]
	const lines: TableLine[] = [rule('┌', '┬', '┐')]
	lines.push(...drawRow(wrapRow(headers), widths, () => 'center', true))
	for (const cells of body) {
		lines.push(rule('├', '┼', '┤'))
		lines.push(...drawRow(cells, widths, (c) => align?.[c] ?? 'left', false))
	}
	lines.push(rule('└', '┴', '┘'))
	return { mode: 'grid', lines }
}

/**
 * Column widths that fit `room`, or `undefined` when even every column's
 * longest word does not.
 *
 * Columns that want no more than an even share get what they want, first —
 * a short label column is never wrapped to make room for a long one that
 * would wrap anyway. The columns left share what remains: each gets its
 * longest word, and the spare is divided in proportion to how much more each
 * wanted.
 */
function columnWidths(
	want: readonly number[],
	least: readonly number[],
	room: number,
): number[] | undefined {
	if (want.reduce((a, b) => a + b, 0) <= room) return [...want]
	const widths = want.map(() => 0)
	let open = want.map((_, c) => c)
	let remaining = room
	for (;;) {
		const share = Math.floor(remaining / Math.max(1, open.length))
		const settled = open.filter((c) => (want[c] ?? 0) <= share)
		if (settled.length === 0 || settled.length === open.length) break
		for (const c of settled) {
			widths[c] = want[c] ?? 0
			remaining -= want[c] ?? 0
		}
		open = open.filter((c) => !settled.includes(c))
	}
	const floor = open.map((c) => Math.min(least[c] ?? 1, want[c] ?? 1))
	const floorTotal = floor.reduce((a, b) => a + b, 0)
	if (floorTotal > remaining) return undefined
	const spare = remaining - floorTotal
	const extra = open.map((c, i) => (want[c] ?? 0) - (floor[i] ?? 0))
	const extraTotal = extra.reduce((a, b) => a + b, 0)
	open.forEach((c, i) => {
		widths[c] =
			(floor[i] ?? 0) + (extraTotal === 0 ? 0 : Math.floor((spare * (extra[i] ?? 0)) / extraTotal))
	})
	// Hand out what rounding left, one cell at a time, to the columns that
	// still want the most.
	let left = room - widths.reduce((a, b) => a + b, 0)
	while (left > 0) {
		let best = -1
		for (let c = 0; c < widths.length; c++) {
			const short = (want[c] ?? 0) - (widths[c] ?? 0)
			if (short > 0 && (best < 0 || short > (want[best] ?? 0) - (widths[best] ?? 0))) best = c
		}
		if (best < 0) break
		widths[best] = (widths[best] ?? 0) + 1
		left -= 1
	}
	return widths
}

function drawRow(
	cells: readonly DisplayLine[][],
	widths: readonly number[],
	alignOf: (column: number) => TableAlign,
	header: boolean,
): TableLine[] {
	const height = Math.max(1, ...cells.map((lines) => lines.length))
	const out: TableLine[] = []
	for (let r = 0; r < height; r++) {
		const line: TableSpan[] = [{ text: '│', border: true }]
		cells.forEach((lines, c) => {
			const content = lines[r] ?? []
			const w = widths[c] ?? 0
			const gap = Math.max(0, w - displayWidth(content))
			const align = alignOf(c)
			const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
			line.push({ text: ` ${' '.repeat(before)}` })
			for (const span of content) line.push(header ? { ...span, header: true } : span)
			line.push({ text: `${' '.repeat(gap - before)} ` })
			line.push({ text: '│', border: true })
		})
		out.push(line)
	}
	return out
}

function stackedLines(
	headers: readonly DisplaySpan[][],
	rows: readonly DisplaySpan[][][],
	width: number,
): TableLine[] {
	const lines: TableLine[] = []
	const rule: TableLine = [
		{ text: '─'.repeat(Math.max(1, Math.min(width, STACKED_RULE_MAX))), border: true },
	]
	rows.forEach((row, r) => {
		if (r > 0) lines.push(rule)
		headers.forEach((header, c) => {
			const label: DisplaySpan[] = [
				...header.map((s) => ({ ...s, bold: true })),
				{ text: ': ', bold: true },
			]
			lines.push(...wrapSpans([...label, ...(row[c] ?? [])], width))
		})
	})
	if (rows.length === 0)
		lines.push(
			...wrapSpans(
				headers.flatMap((h, c) => (c > 0 ? [{ text: ' · ' }, ...h] : h)),
				width,
			),
		)
	return lines
}

/** How many terminal rows a table occupies at `width`, for the live-region height estimate. */
export function tableHeight(table: TableSource, width: number): number {
	return layoutTable(table, width).lines.length
}
