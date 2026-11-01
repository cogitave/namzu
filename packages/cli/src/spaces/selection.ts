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
export function extractText(source: TextSource, range: Range): string {
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

/** Characters that end a word on a double click. */
const WORD_BREAK = /[\s"'`()[\]{}<>,;|]/u

/** The run of non-blank, non-bracket characters around a cell; the cell alone when it is blank. */
export function wordAt(source: TextSource, line: number, col: number): Range {
	// One entry per column: the second half of a wide character is empty and belongs to the first.
	const cells: string[] = []
	for (let c = 0; c < source.cols; c++) cells.push(source.lineText(line, c, c + 1, false))
	const breaks = (c: number): boolean => {
		const ch = cells[c] ?? ' '
		return ch !== '' && WORD_BREAK.test(ch)
	}
	const at = Math.max(0, Math.min(col, cells.length - 1))
	if (cells.length === 0 || breaks(at)) return { start: { line, col }, end: { line, col } }
	let start = at
	let end = at
	while (start > 0 && !breaks(start - 1)) start--
	while (end < cells.length - 1 && !breaks(end + 1)) end++
	return { start: { line, col: start }, end: { line, col: end } }
}

/** The whole line, without its trailing blanks. */
export function lineAt(source: TextSource, line: number): Range {
	const used = source.lineText(line, 0, source.cols, true).replace(/[ \t]+$/u, '')
	return { start: { line, col: 0 }, end: { line, col: Math.max(0, [...used].length - 1) } }
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
