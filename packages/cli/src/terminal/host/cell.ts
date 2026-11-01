/**
 * One character cell of a terminal screen, in a form that compares with `===`
 * on its fields and serializes to a short SGR sequence.
 *
 * Colours are numbers: -1 is the terminal default, 0..255 a palette entry, and
 * `RGB_FLAG | 0xRRGGBB` a true colour.
 */
export interface Cell {
	/** The cluster drawn in this cell; '' for the second half of a wide character. */
	readonly ch: string
	/** Columns the cell occupies: 1, 2 for the first half of a wide character, 0 for its second half. */
	readonly width: 0 | 1 | 2
	readonly fg: number
	readonly bg: number
	readonly attrs: number
}

export const DEFAULT_COLOR = -1
export const RGB_FLAG = 0x1000000

export const ATTR_BOLD = 1
export const ATTR_DIM = 2
export const ATTR_ITALIC = 4
export const ATTR_UNDERLINE = 8
export const ATTR_BLINK = 16
export const ATTR_INVERSE = 32
export const ATTR_INVISIBLE = 64
export const ATTR_STRIKE = 128
export const ATTR_OVERLINE = 256

export const BLANK_CELL: Cell = Object.freeze({
	ch: ' ',
	width: 1,
	fg: DEFAULT_COLOR,
	bg: DEFAULT_COLOR,
	attrs: 0,
})

/** The second half of a wide character: drawn by the first half, never written itself. */
export const CONTINUATION_CELL: Cell = Object.freeze({
	ch: '',
	width: 0,
	fg: DEFAULT_COLOR,
	bg: DEFAULT_COLOR,
	attrs: 0,
})

export function sameCell(a: Cell, b: Cell): boolean {
	return (
		a === b ||
		(a.ch === b.ch && a.width === b.width && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs)
	)
}

export function rgb(r: number, g: number, b: number): number {
	return RGB_FLAG | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

function colorParams(color: number, base: 30 | 40): string {
	if (color >= RGB_FLAG) {
		const v = color & 0xffffff
		return `${base + 8};2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`
	}
	if (color < 8) return String(base + color)
	if (color < 16) return String(base + 60 + (color - 8))
	return `${base + 8};5;${color}`
}

const ATTR_CODES: ReadonlyArray<readonly [number, number]> = [
	[ATTR_BOLD, 1],
	[ATTR_DIM, 2],
	[ATTR_ITALIC, 3],
	[ATTR_UNDERLINE, 4],
	[ATTR_BLINK, 5],
	[ATTR_INVERSE, 7],
	[ATTR_INVISIBLE, 8],
	[ATTR_STRIKE, 9],
	[ATTR_OVERLINE, 53],
]

/** The SGR sequence that sets exactly this style from a reset state. */
export function sgr(fg: number, bg: number, attrs: number): string {
	const params = ['0']
	for (const [bit, code] of ATTR_CODES) if (attrs & bit) params.push(String(code))
	if (fg !== DEFAULT_COLOR) params.push(colorParams(fg, 30))
	if (bg !== DEFAULT_COLOR) params.push(colorParams(bg, 40))
	return `\x1b[${params.join(';')}m`
}
