/**
 * Text selection on a pane's screen, in the terminal emulator's own lines.
 *
 * A point is a line of the emulator's buffer (history included) and a column, so the
 * wheel scrolling, or new output arriving, while a selection is being made does not
 * move it. Nothing here knows about the screen the host draws or the clipboard.
 */

/** What selection reads of a screen. */
export interface TextSource {
	readonly cols: number
	bufferLength(): number
	lineText(line: number, from: number, to: number, trim?: boolean): string
	lineWrapped(line: number): boolean
	/** Columns the cell at `col` takes: 2 for a wide character, 0 for the second half of one, 1 otherwise. */
	cellWidth(line: number, col: number): number
}

export interface Point {
	readonly line: number
	readonly col: number
}

/** From `start` to `end`, both cells included, `start` first. */
export interface Range {
	readonly start: Point
	readonly end: Point
}

export function orderRange(a: Point, b: Point): Range {
	const forward = a.line < b.line || (a.line === b.line && a.col <= b.col)
	return forward ? { start: a, end: b } : { start: b, end: a }
}

/** The columns of `line` the range covers, as `[from, to)`; undefined when it does not reach the line. */
export function colsOnLine(
	range: Range,
	line: number,
	cols: number,
): readonly [number, number] | undefined {
	if (line < range.start.line || line > range.end.line) return undefined
	const from = line === range.start.line ? range.start.col : 0
	const to = line === range.end.line ? range.end.col + 1 : cols
	return to > from ? [from, Math.min(to, cols)] : undefined
}

/**
 * The text of a range. Each line loses its trailing blanks; a line the program wrapped joins the
 * next without a line break. Attributes and escape sequences are never part of it.
 */
export function extractText(source: TextSource, raw: Range): string {
	const range = snapRange(source, raw)
	let out = ''
	for (let line = range.start.line; line <= range.end.line; line++) {
		const cols = colsOnLine(range, line, source.cols)
		if (!cols) {
			if (line < range.end.line) out += '\n'
			continue
		}
		const last = line === range.end.line
		const joins = !last && source.lineWrapped(line + 1) && cols[1] >= source.cols
		const text = source.lineText(line, cols[0], cols[1], !joins)
		out += joins ? text : text.replace(/[ \t]+$/u, '')
		if (!last && !joins) out += '\n'
	}
	return out
}

/** The first column of the cell that holds `col`: the second half of a wide character belongs to the first. */
export function cellStart(source: TextSource, line: number, col: number): number {
	let c = Math.max(0, Math.min(col, source.cols - 1))
	while (c > 0 && source.cellWidth(line, c) === 0) c--
	return c
}

/** The last column of the cell that holds `col`. */
export function cellEnd(source: TextSource, line: number, col: number): number {
	const start = cellStart(source, line, col)
	return Math.min(source.cols - 1, start + Math.max(1, source.cellWidth(line, start)) - 1)
}

/** The range grown to whole cells: a wide character is never cut in half. */
export function snapRange(source: TextSource, range: Range): Range {
	const { start, end } = range
	return {
		start: { line: start.line, col: cellStart(source, start.line, start.col) },
		end: { line: end.line, col: cellEnd(source, end.line, end.col) },
	}
}

/** Characters that end a word on a double click. */
const WORD_BREAK = /[\s"'`()[\]{}<>,;|]/u

/** The run of non-blank, non-bracket characters around a cell; the cell alone when it is blank. */
export function wordAt(source: TextSource, line: number, col: number): Range {
	// One entry per column, naming the cell that owns it: the second half of a wide character
	// is part of the first, never a break.
	const breaks = (c: number): boolean => {
		const s = cellStart(source, line, c)
		const ch = source.lineText(line, s, s + 1, false)
		return ch === '' || WORD_BREAK.test(ch)
	}
	const last = source.cols - 1
	const at = cellStart(source, line, col)
	if (last < 0 || breaks(at)) {
		return { start: { line, col: at }, end: { line, col: cellEnd(source, line, at) } }
	}
	let start = at
	let end = cellEnd(source, line, at)
	while (start > 0 && !breaks(start - 1)) start = cellStart(source, line, start - 1)
	while (end < last && !breaks(end + 1)) end = cellEnd(source, line, end + 1)
	return { start: { line, col: start }, end: { line, col: end } }
}

/** The whole line the program printed, wrapped rows included, without its trailing blanks. */
export function lineAt(source: TextSource, line: number): Range {
	let first = line
	while (first > 0 && source.lineWrapped(first)) first--
	let last = line
	while (last + 1 < source.bufferLength() && source.lineWrapped(last + 1)) last++
	// The last column that shows something, scanning from the right.
	let end = -1
	for (let c = source.cols - 1; c >= 0; c--) {
		if (source.cellWidth(last, c) === 0) continue
		if (source.lineText(last, c, c + 1, false).trim() !== '') {
			end = cellEnd(source, last, c)
			break
		}
	}
	return { start: { line: first, col: 0 }, end: { line: last, col: Math.max(0, end) } }
}

/** Counts presses made in the same place within `windowMs` of each other: 1, 2, 3, then 1 again. */
export class ClickCounter {
	private last: { x: number; y: number; at: number; count: number } | undefined

	constructor(
		private readonly now: () => number,
		private readonly windowMs: number,
	) {}

	press(x: number, y: number): 1 | 2 | 3 {
		const at = this.now()
		const last = this.last
		const count: 1 | 2 | 3 =
			last && last.x === x && last.y === y && at - last.at <= this.windowMs
				? last.count === 1
					? 2
					: last.count === 2
						? 3
						: 1
				: 1
		this.last = { x, y, at, count }
		return count
	}
}
