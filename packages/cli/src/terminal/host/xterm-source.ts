import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless'
import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_DIM,
	ATTR_INVERSE,
	ATTR_INVISIBLE,
	ATTR_ITALIC,
	ATTR_OVERLINE,
	ATTR_STRIKE,
	ATTR_UNDERLINE,
	BLANK_CELL,
	CONTINUATION_CELL,
	type Cell,
	DEFAULT_COLOR,
	RGB_FLAG,
} from './cell.js'
import type { CellSource, FrameCursor } from './frame.js'

function color(isDefault: boolean, isRgb: boolean, isPalette: boolean, value: number): number {
	if (isDefault) return DEFAULT_COLOR
	if (isRgb) return RGB_FLAG | (value & 0xffffff)
	return isPalette ? value & 0xff : DEFAULT_COLOR
}

/** Converts one emulator cell. The emulator's cell object is reused by `getCell`, so this copies. */
export function readCell(cell: IBufferCell): Cell {
	const width = cell.getWidth()
	if (width === 0) return CONTINUATION_CELL
	const chars = cell.getChars()
	let attrs = 0
	if (cell.isBold()) attrs |= ATTR_BOLD
	if (cell.isDim()) attrs |= ATTR_DIM
	if (cell.isItalic()) attrs |= ATTR_ITALIC
	if (cell.isUnderline()) attrs |= ATTR_UNDERLINE
	if (cell.isBlink()) attrs |= ATTR_BLINK
	if (cell.isInverse()) attrs |= ATTR_INVERSE
	if (cell.isInvisible()) attrs |= ATTR_INVISIBLE
	if (cell.isStrikethrough()) attrs |= ATTR_STRIKE
	if (cell.isOverline()) attrs |= ATTR_OVERLINE
	const fg = color(cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor())
	const bg = color(cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())
	if (
		(chars === ' ' || chars === '') &&
		fg === DEFAULT_COLOR &&
		bg === DEFAULT_COLOR &&
		attrs === 0 &&
		width === 1
	)
		return BLANK_CELL
	return { ch: chars === '' ? ' ' : chars, width: width === 2 ? 2 : 1, fg, bg, attrs }
}

/**
 * Tracks whether the emulated program has hidden the cursor. The emulator does
 * not expose it, so this watches the cursor-visibility mode toggles while
 * leaving them for the emulator to handle.
 */
export function trackCursorVisibility(term: Terminal): () => boolean {
	let visible = true
	const handler =
		(on: boolean) =>
		(params: readonly (number | number[])[]): boolean => {
			if (params.some((p) => p === 25)) visible = on
			return false
		}
	term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handler(true))
	term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handler(false))
	return () => visible
}

/**
 * A `CellSource` over the emulator's active buffer (so a program on the
 * alternate screen is read from it), showing the viewport scrolled `back` rows
 * into the scrollback. The cursor is hidden while scrolled back.
 */
export function xtermSource(
	term: Terminal,
	cursorVisible: () => boolean = () => true,
	back = 0,
): CellSource {
	const buffer = term.buffer.active
	const scrolled = Math.max(0, Math.min(back, buffer.baseY))
	const top = buffer.viewportY - scrolled
	const scratch = buffer.getNullCell()
	const lines = new Map<number, IBufferLine | undefined>()
	const cursor: FrameCursor = {
		x: buffer.cursorX,
		y: buffer.cursorY,
		visible: cursorVisible() && scrolled === 0,
	}
	return {
		cols: term.cols,
		rows: term.rows,
		cursor,
		cell(x, y) {
			if (x < 0 || y < 0 || x >= term.cols || y >= term.rows) return undefined
			let line = lines.get(y)
			if (line === undefined && !lines.has(y)) {
				line = buffer.getLine(top + y)
				lines.set(y, line)
			}
			const cell = line?.getCell(x, scratch)
			return cell ? readCell(cell) : BLANK_CELL
		},
	}
}
