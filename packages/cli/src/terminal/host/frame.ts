import stringWidth from 'string-width'
import { BLANK_CELL, CONTINUATION_CELL, type Cell } from './cell.js'

export interface Rect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/** Style applied to text and fills written by the sidebar API. */
export interface CellStyle {
	readonly fg?: number
	readonly bg?: number
	readonly attrs?: number
}

/** Where the real terminal's cursor should rest after a frame, in frame coordinates. */
export interface FrameCursor {
	readonly x: number
	readonly y: number
	readonly visible: boolean
}

/**
 * A read-only view of a screen that can be copied into a frame. The terminal
 * emulator adapter implements it; tests may implement it directly.
 */
export interface CellSource {
	readonly cols: number
	readonly rows: number
	/** The cell at a visible position, or undefined outside the screen. */
	cell(x: number, y: number): Cell | undefined
	readonly cursor: FrameCursor
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The picture of the whole real terminal for one instant: every cell, plus the
 * cursor. Regions of it are filled from child screens (`blit`) and by the host's
 * own chrome (`fillRect`, `writeText`). Nothing here touches stdout; a
 * `DiffWriter` turns the difference between two frames into bytes.
 */
export class Frame {
	readonly cells: Cell[]
	cursor: FrameCursor = { x: 0, y: 0, visible: false }

	constructor(
		readonly cols: number,
		readonly rows: number,
	) {
		this.cells = new Array<Cell>(cols * rows).fill(BLANK_CELL)
	}

	cellAt(x: number, y: number): Cell | undefined {
		if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return undefined
		return this.cells[y * this.cols + x]
	}

	/** Sets one cell, ignoring positions outside the frame. */
	set(x: number, y: number, cell: Cell): void {
		if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
		this.cells[y * this.cols + x] = cell
	}

	private clip(rect: Rect): Rect {
		const x = Math.max(0, rect.x)
		const y = Math.max(0, rect.y)
		const right = Math.min(this.cols, rect.x + rect.width)
		const bottom = Math.min(this.rows, rect.y + rect.height)
		return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
	}

	/** Fills a rectangle with blanks in the given style. */
	fillRect(rect: Rect, style: CellStyle = {}): void {
		const blank = styled(' ', 1, style)
		const r = this.clip(rect)
		for (let y = r.y; y < r.y + r.height; y++)
			for (let x = r.x; x < r.x + r.width; x++) this.cells[y * this.cols + x] = blank
	}

	/**
	 * Writes text on one row of a rectangle, clipped to the rectangle's width. Wide
	 * characters take two cells; one that would straddle the right edge is replaced
	 * by a blank. Returns the number of columns used.
	 */
	writeText(rect: Rect, row: number, text: string, style: CellStyle = {}): number {
		if (row < 0 || row >= rect.height) return 0
		const y = rect.y + row
		let used = 0
		for (const { segment } of segmenter.segment(text)) {
			const w = Math.min(2, stringWidth(segment))
			if (w === 0) continue
			if (used + w > rect.width) {
				if (used < rect.width) {
					this.set(rect.x + used, y, styled(' ', 1, style))
					used += 1
				}
				break
			}
			this.set(rect.x + used, y, styled(segment, w as 1 | 2, style))
			if (w === 2) this.set(rect.x + used + 1, y, CONTINUATION_CELL)
			used += w
		}
		return used
	}

	/**
	 * Copies a source screen into a rectangle, top-left aligned and clipped to the
	 * rectangle, the frame and the source. A wide character cut by the clip edge, or
	 * whose second half is missing, becomes a blank.
	 */
	blit(source: CellSource, rect: Rect): void {
		const r = this.clip(rect)
		// The rectangle's origin must lie inside the frame; only its far edges are clipped.
		const w = Math.min(r.width, source.cols)
		const h = Math.min(r.height, source.rows)
		for (let dy = 0; dy < h; dy++) {
			for (let dx = 0; dx < w; dx++) {
				let cell = source.cell(dx, dy) ?? BLANK_CELL
				if (cell.width === 2 && dx + 1 >= w) cell = BLANK_CELL
				else if (cell.width === 0 && dx === 0) cell = BLANK_CELL
				this.cells[(r.y + dy) * this.cols + r.x + dx] = cell
			}
		}
		const c = source.cursor
		const cx = rect.x + c.x
		const cy = rect.y + c.y
		const inside = cx >= r.x && cx < r.x + w && cy >= r.y && cy < r.y + h
		this.cursor = { x: cx, y: cy, visible: c.visible && inside }
	}

	/** Places the cursor explicitly (for example on a sidebar input row). */
	setCursor(cursor: FrameCursor): void {
		this.cursor = cursor
	}
}

function styled(ch: string, width: 1 | 2, style: CellStyle): Cell {
	if (ch === ' ' && style.fg === undefined && style.bg === undefined && !style.attrs)
		return BLANK_CELL
	return { ch, width, fg: style.fg ?? -1, bg: style.bg ?? -1, attrs: style.attrs ?? 0 }
}
