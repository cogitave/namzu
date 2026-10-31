import { type Cell, sameCell, sgr } from './cell.js'
import type { Frame, FrameCursor } from './frame.js'

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/**
 * Turns successive frames into the smallest byte stream that makes the real
 * terminal show the newest one: only cells that differ from the previous frame
 * are written, each run of changed cells in a row gets one cursor move and one
 * style change per style, and the cursor ends on the frame's cursor.
 *
 * Output is wrapped in synchronized-update markers so a terminal that supports
 * them paints the frame at once; the others ignore the markers.
 */
export class DiffWriter {
	private previous: readonly Cell[] | undefined
	private previousCols = 0
	private previousRows = 0
	private cursor: FrameCursor | undefined

	/** Forget what the terminal shows; the next render repaints every cell. */
	invalidate(): void {
		this.previous = undefined
		this.cursor = undefined
	}

	/** The bytes that bring the terminal from the previous frame to this one. Empty when nothing changed. */
	render(frame: Frame): string {
		const full =
			this.previous === undefined ||
			this.previousCols !== frame.cols ||
			this.previousRows !== frame.rows
		let body = full ? '\x1b[0m\x1b[2J' : ''
		let sgrFg = -1
		let sgrBg = -1
		let sgrAttrs = 0
		let styleKnown = false
		const prev = full ? undefined : this.previous

		for (let y = 0; y < frame.rows; y++) {
			let runEnd = -1 // column the terminal cursor sits at after the last write in this row
			for (let x = 0; x < frame.cols; x++) {
				const cell = frame.cells[y * frame.cols + x] as Cell
				if (cell.width === 0) continue
				const before = prev?.[y * frame.cols + x]
				const second = cell.width === 2 ? frame.cells[y * frame.cols + x + 1] : undefined
				const beforeSecond = cell.width === 2 ? prev?.[y * frame.cols + x + 1] : undefined
				const unchanged =
					before !== undefined &&
					sameCell(before, cell) &&
					(second === undefined ||
						(beforeSecond !== undefined && sameCell(beforeSecond, second as Cell)))
				if (unchanged) {
					if (cell.width === 2) x += 1
					continue
				}
				// A blank over a full-screen clear needs no write.
				if (full && cell.ch === ' ' && cell.fg === -1 && cell.bg === -1 && cell.attrs === 0)
					continue
				if (runEnd !== x) body += `\x1b[${y + 1};${x + 1}H`
				if (!styleKnown || cell.fg !== sgrFg || cell.bg !== sgrBg || cell.attrs !== sgrAttrs) {
					body += sgr(cell.fg, cell.bg, cell.attrs)
					sgrFg = cell.fg
					sgrBg = cell.bg
					sgrAttrs = cell.attrs
					styleKnown = true
				}
				body += cell.ch
				runEnd = x + cell.width
				if (cell.width === 2) x += 1
			}
		}

		const c = frame.cursor
		const cursorChanged =
			full ||
			this.cursor === undefined ||
			this.cursor.x !== c.x ||
			this.cursor.y !== c.y ||
			this.cursor.visible !== c.visible
		const wrote = body.length > 0
		let out = ''
		if (wrote || cursorChanged) {
			out = HIDE_CURSOR + body + (styleKnown ? '\x1b[0m' : '')
			if (c.visible) out += `\x1b[${c.y + 1};${c.x + 1}H${SHOW_CURSOR}`
			if (wrote) out = SYNC_BEGIN + out + SYNC_END
		}
		this.previous = frame.cells.slice()
		this.previousCols = frame.cols
		this.previousRows = frame.rows
		this.cursor = { ...c }
		return out
	}
}
