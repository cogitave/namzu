/**
 * Zoom out of the running conversation to a "spaces" screen, and back.
 *
 * Imported on the first zoom only (it pulls in the terminal emulator and the
 * cell-frame code), through `index.tsx`'s dynamic import.
 *
 * Zoomed out, the real terminal is on the alternate screen and shows a frame
 * this module draws: a sidebar and, to its right, the cells of a headless
 * mirror that Ink writes into at the pane's size. The main screen underneath is
 * not touched, so a failure here leaves the terminal as it was.
 *
 * Zooming in leaves the alternate screen (the main screen and cursor come back
 * as they were at zoom-out) and tells Ink the real size. The App answers a
 * change of width by clearing the screen and scrollback and reprinting the
 * whole transcript from its own message list (`resetTranscript`, in
 * `App.tsx`), so the native scrollback is rebuilt exactly and in full,
 * including what was produced while zoomed out. That is the repaint; nothing
 * here keeps a copy of Ink's output to replay.
 */

import { DiffWriter, Frame, type Rect, rgb } from '../../terminal/host/index.js'
import { HeadlessScreen } from '../../terminal/screen.js'
import type { TerminalProxy } from './proxy.js'

const ENTER = '\u001b[?1049h\u001b[?25l'
const LEAVE = '\u001b[?1049l'
const SIDEBAR_WIDTH = 24
const MIN_COLS = 50
const MIN_ROWS = 8
const MIRROR_SCROLLBACK = 1000
const KEY_RIGHT = ['\u001b[C', '\u001bOC']
const KEY_INTERRUPT = '\u0003'
const KEY_TOGGLE = '\u001d'
const KEY_ENTER = '\r'
const KEY_ESC = '\u001b'

export type ZoomFocus = 'sidebar' | 'pane'

export interface ZoomController {
	readonly zoomed: boolean
	readonly focus: ZoomFocus
	zoomOut(): boolean
	zoomIn(): void
	/** Resolves once everything Ink wrote has been drawn. For tests. */
	drawn(): Promise<void>
}

export interface Layout {
	readonly sidebar: Rect
	readonly pane: Rect
	readonly status: Rect
}

export function layoutFor(cols: number, rows: number): Layout | null {
	if (cols < MIN_COLS || rows < MIN_ROWS) return null
	const side = Math.min(SIDEBAR_WIDTH, Math.floor(cols / 3))
	return {
		sidebar: { x: 0, y: 0, width: side, height: rows - 1 },
		pane: { x: side + 1, y: 0, width: cols - side - 1, height: rows - 1 },
		status: { x: 0, y: rows - 1, width: cols, height: 1 },
	}
}

const DIM = rgb(110, 110, 120)
const ACCENT = rgb(120, 190, 255)

export function createZoomController(
	proxy: TerminalProxy,
	realOut: NodeJS.WriteStream,
): ZoomController {
	let mirror: HeadlessScreen | null = null
	let layout: Layout | null = null
	let writer = new DiffWriter()
	let focus: ZoomFocus = 'sidebar'
	let zoomed = false
	let drawing: Promise<void> | null = null
	let onExitHandler: (() => void) | null = null

	const draw = (): void => {
		if (!zoomed || mirror === null || layout === null) return
		const cols = realOut.columns ?? 80
		const rows = realOut.rows ?? 24
		const frame = new Frame(cols, rows)
		frame.writeText(layout.sidebar, 0, ' SPACES', { fg: ACCENT, attrs: 1 })
		frame.writeText(layout.sidebar, 2, ' * this session', {
			fg: focus === 'sidebar' ? ACCENT : -1,
		})
		frame.writeText(layout.sidebar, 3, '   (placeholder)', { fg: DIM })
		for (let y = 0; y < layout.sidebar.height; y++)
			frame.writeText({ x: layout.sidebar.width, y, width: 1, height: 1 }, 0, '│', { fg: DIM })
		frame.blit(mirror.cells(0), layout.pane)
		if (focus === 'sidebar') frame.setCursor({ x: 0, y: 0, visible: false })
		const hint =
			focus === 'sidebar'
				? ' enter type in the pane  ·  → back to the session  ·  ctrl+c quit'
				: ' typing in the pane  ·  esc sidebar'
		frame.writeText(layout.status, 0, hint, { fg: DIM })
		const bytes = writer.render(frame)
		if (bytes.length > 0) realOut.write(bytes)
	}

	const scheduleDraw = (): void => {
		if (drawing !== null || mirror === null) return
		drawing = mirror.settled().then(() => {
			drawing = null
			draw()
		})
	}

	const onKey = (chunk: string): string | null => {
		if (chunk.includes(KEY_TOGGLE)) {
			controller.zoomIn()
			return null
		}
		if (focus === 'sidebar') {
			// Ctrl+C must still quit: Ink owns that, so hand it over and let the exit handler restore the screen.
			if (chunk.includes(KEY_INTERRUPT)) return chunk
			// A key may arrive glued to another in one chunk; the arrow counts wherever it sits.
			if (KEY_RIGHT.some((k) => chunk.includes(k))) controller.zoomIn()
			else if (chunk === KEY_ENTER) {
				focus = 'pane'
				scheduleDraw()
			}
			return null
		}
		if (chunk === KEY_ESC) {
			focus = 'sidebar'
			scheduleDraw()
			return null
		}
		return chunk
	}

	const relayout = (): void => {
		if (!zoomed || mirror === null) return
		const next = layoutFor(realOut.columns ?? 80, realOut.rows ?? 24)
		if (next === null) return
		layout = next
		// The mirror first, so what Ink writes in answer to the resize lands in a screen of the new size.
		mirror.resize(next.pane.width, next.pane.height)
		writer = new DiffWriter()
		proxy.resizeZoomed(next.pane.width, next.pane.height)
		scheduleDraw()
	}

	const controller: ZoomController = {
		get zoomed() {
			return zoomed
		},
		get focus() {
			return focus
		},
		zoomOut() {
			if (zoomed) return false
			const next = layoutFor(realOut.columns ?? 80, realOut.rows ?? 24)
			if (next === null) return false
			layout = next
			mirror = new HeadlessScreen(next.pane.width, next.pane.height, MIRROR_SCROLLBACK)
			writer = new DiffWriter()
			focus = 'sidebar'
			zoomed = true
			realOut.write(ENTER)
			proxy.onRealResize(relayout)
			onExitHandler = () => {
				if (zoomed) realOut.write(LEAVE)
			}
			process.once('exit', onExitHandler)
			const screen = mirror
			proxy.enterZoomed(
				{
					columns: next.pane.width,
					rows: next.pane.height,
					write(chunk) {
						// The terminal's line discipline turns LF into CR LF for a real screen; the mirror has none.
						screen.write(chunk.replace(/\r?\n/g, '\r\n'))
						scheduleDraw()
					},
				},
				onKey,
			)
			scheduleDraw()
			return true
		},
		zoomIn() {
			if (!zoomed) return
			zoomed = false
			if (onExitHandler) process.off('exit', onExitHandler)
			onExitHandler = null
			realOut.write(LEAVE)
			realOut.write(proxy.cursorHidden ? '\u001b[?25l' : '\u001b[?25h')
			proxy.leaveZoomed()
			mirror?.dispose()
			mirror = null
			layout = null
		},
		drawn() {
			return drawing ?? Promise.resolve()
		},
	}
	return controller
}
