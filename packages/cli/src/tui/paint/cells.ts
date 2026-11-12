/**
 * One row of the live region as cells, and the shortest write that turns one row into another.
 *
 * A row is text with colour sequences and hyperlink marks. Two rows are compared cell by cell
 * (a cell is one grapheme with the colours and link it is drawn in), so a label whose colour
 * moves one letter along costs a cursor move and that letter, not the whole line.
 *
 * Only colour sequences (`SGR`) and hyperlink marks (`OSC 8`) are understood. A row with any
 * other escape or a control character is not cut into cells: the caller rewrites it whole.
 */

import stringWidth from 'string-width'

const ESC = '\u001b'
const RESET = `${ESC}[0m`
const LINK_CLOSE = `${ESC}]8;;${ESC}\\`
const ERASE_TO_END = `${ESC}[K`

export interface Cell {
	/** The grapheme. */
	readonly g: string
	readonly width: number
	/** The colours it is drawn in, as the one sequence that sets them from a reset (`''` for none). */
	readonly sgr: string
	/** The link it belongs to, as the sequence that opens it (`''` for none). */
	readonly link: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** On-code to the code that turns it off. */
const FLAGS = new Map<number, number>([
	[1, 22],
	[2, 22],
	[3, 23],
	[4, 24],
	[5, 25],
	[7, 27],
	[8, 28],
	[9, 29],
	[53, 55],
])
const OFF_TO_ON = new Map<number, readonly number[]>([
	[22, [1, 2]],
	[23, [3]],
	[24, [4]],
	[25, [5]],
	[27, [7]],
	[28, [8]],
	[29, [9]],
	[55, [53]],
])

interface Colours {
	flags: Set<number>
	fg: string
	bg: string
	ul: string
}

const plain = (): Colours => ({ flags: new Set(), fg: '', bg: '', ul: '' })

function serialise(c: Colours): string {
	const parts = [...c.flags].sort((a, b) => a - b).map(String)
	if (c.fg) parts.push(c.fg)
	if (c.bg) parts.push(c.bg)
	if (c.ul) parts.push(c.ul)
	return parts.length === 0 ? '' : `${ESC}[${parts.join(';')}m`
}

/** Reads the extended colour that starts at `params[at]` (38, 48 or 58); null when it is not one we know. */
function extended(params: readonly number[], at: number): { text: string; used: number } | null {
	const kind = params[at + 1]
	if (kind === 5 && params[at + 2] !== undefined) {
		return { text: `${params[at]};5;${params[at + 2]}`, used: 3 }
	}
	if (
		kind === 2 &&
		params[at + 2] !== undefined &&
		params[at + 3] !== undefined &&
		params[at + 4] !== undefined
	) {
		return {
			text: `${params[at]};2;${params[at + 2]};${params[at + 3]};${params[at + 4]}`,
			used: 5,
		}
	}
	return null
}

/** Applies one `SGR` parameter list to `c`; false when it holds something this reader does not know. */
function applySgr(c: Colours, raw: string): boolean {
	if (raw.includes(':')) return false
	const params = raw === '' ? [0] : raw.split(';').map((p) => (p === '' ? 0 : Number(p)))
	for (let i = 0; i < params.length; i++) {
		const code = params[i] as number
		if (!Number.isInteger(code)) return false
		if (code === 0) {
			c.flags.clear()
			c.fg = ''
			c.bg = ''
			c.ul = ''
		} else if (FLAGS.has(code)) c.flags.add(code)
		else if (OFF_TO_ON.has(code)) for (const on of OFF_TO_ON.get(code) ?? []) c.flags.delete(on)
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) c.fg = String(code)
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) c.bg = String(code)
		else if (code === 39) c.fg = ''
		else if (code === 49) c.bg = ''
		else if (code === 59) c.ul = ''
		else if (code === 38 || code === 48 || code === 58) {
			const colour = extended(params, i)
			if (colour === null) return false
			if (code === 38) c.fg = colour.text
			else if (code === 48) c.bg = colour.text
			else c.ul = colour.text
			i += colour.used - 1
		} else return false
	}
	return true
}

const SGR = new RegExp(`${ESC}\\[([0-9;:]*)m`, 'y')
const OSC8 = new RegExp(
	`${ESC}\\]8;([^\\u0007${ESC}]*);([^\\u0007${ESC}]*)(?:\\u0007|${ESC}\\\\)`,
	'y',
)

/** The row as cells, or null when it holds anything but text, colours and links. */
export function parseRow(row: string): Cell[] | null {
	const cells: Cell[] = []
	const colours = plain()
	let sgr = ''
	let link = ''
	let i = 0
	while (i < row.length) {
		const code = row.charCodeAt(i)
		if (code === 0x1b) {
			const next = row[i + 1]
			if (next === '[') {
				SGR.lastIndex = i
				const hit = SGR.exec(row)
				if (hit === null || !applySgr(colours, hit[1] ?? '')) return null
				sgr = serialise(colours)
				i += hit[0].length
			} else if (next === ']') {
				OSC8.lastIndex = i
				const hit = OSC8.exec(row)
				if (hit === null) return null
				link = hit[2] === '' ? '' : hit[0]
				i += hit[0].length
			} else return null
			continue
		}
		if (code < 0x20 || code === 0x7f) return null
		let end = i + 1
		while (end < row.length) {
			const c = row.charCodeAt(end)
			if (c === 0x1b || c < 0x20 || c === 0x7f) break
			end++
		}
		const run = row.slice(i, end)
		for (const { segment } of segmenter.segment(run)) {
			const width = segment.length === 1 && segment < '\u007f' ? 1 : stringWidth(segment)
			cells.push({ g: segment, width, sgr, link })
		}
		i = end
	}
	return cells
}

const sameCell = (a: Cell, b: Cell): boolean => a.g === b.g && a.sgr === b.sgr && a.link === b.link

const widthOf = (cells: readonly Cell[], from: number, to: number): number => {
	let w = 0
	for (let i = from; i < to; i++) w += (cells[i] as Cell).width
	return w
}

/** What the terminal must be told to draw `cells` from a reset state, ending reset. */
function drawCells(cells: readonly Cell[], from: number, to: number): string {
	let out = ''
	let sgr = ''
	let link = ''
	for (let i = from; i < to; i++) {
		const cell = cells[i] as Cell
		if (cell.link !== link) {
			out += cell.link === '' ? LINK_CLOSE : cell.link
			link = cell.link
		}
		if (cell.sgr !== sgr) {
			out += cell.sgr === '' ? RESET : sgr === '' ? cell.sgr : RESET + cell.sgr
			sgr = cell.sgr
		}
		out += cell.g
	}
	if (link !== '') out += LINK_CLOSE
	if (sgr !== '') out += RESET
	return out
}

/** The whole row, from column one, with whatever the old row left to its right erased. */
export function writeWholeRow(row: string): string {
	return `\r${row}${row.includes(ESC) ? RESET : ''}${ERASE_TO_END}`
}

/**
 * The shortest write that makes the row on screen `before` into `after`, for a cursor on
 * that row at any column. Empty when they are the same.
 */
export function writeRowChange(before: string, after: string): string {
	if (before === after) return ''
	const whole = writeWholeRow(after)
	const old = parseRow(before)
	const next = parseRow(after)
	if (old === null || next === null) return whole
	const room = Math.min(old.length, next.length)
	let head = 0
	while (head < room && sameCell(old[head] as Cell, next[head] as Cell)) head++
	let tail = 0
	while (
		tail < room - head &&
		sameCell(old[old.length - 1 - tail] as Cell, next[next.length - 1 - tail] as Cell)
	)
		tail++
	// The matching end only stays where it is if what replaces the middle is as wide.
	const oldEnd = old.length - tail
	const nextEnd = next.length - tail
	if (tail > 0 && widthOf(old, head, oldEnd) !== widthOf(next, head, nextEnd)) {
		tail = 0
	}
	const stop = next.length - tail
	const column = widthOf(next, 0, head) + 1
	const shorter = tail === 0 && widthOf(next, 0, next.length) < widthOf(old, 0, old.length)
	const change = `${ESC}[${column}G${drawCells(next, head, stop)}${shorter ? ERASE_TO_END : ''}`
	return change.length < whole.length ? change : whole
}

/** The display width of a row as the terminal draws it: what reflow at another width needs. */
export function rowWidth(row: string): number {
	const cells = parseRow(row)
	return cells === null ? stringWidth(row) : widthOf(cells, 0, cells.length)
}
