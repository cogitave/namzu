import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, type Display, ipcMain, screen } from 'electron'
import { markProtectedByDefault } from './recording/protection.js'
import { PILL_COLLAPSED_HEIGHT, PILL_WIDTH, pillPage } from './working-pill-page.js'
import type { PillAction, PillSurface, PillView } from './working-pill.js'

/** The height the pill needs for what it shows. */
export function pillHeight(view: PillView): number {
	if (!view.approval) return PILL_COLLAPSED_HEIGHT
	return (
		PILL_COLLAPSED_HEIGHT + 72 + (view.approval.detail ? 18 : 0) + (view.approval.warning ? 18 : 0)
	)
}

/** Near the top centre of a display's work area. */
export function pillPlacement(
	display: Pick<Display, 'workArea'>,
	height: number,
): { x: number; y: number; width: number; height: number } {
	const area = display.workArea
	return {
		x: Math.round(area.x + (area.width - PILL_WIDTH) / 2),
		y: area.y + 10,
		width: PILL_WIDTH,
		height,
	}
}

/**
 * The pill as a window of its own: always on top, never taking focus from the application being
 * driven, and excluded from screen capture so the model neither sees nor clicks it.
 *
 * - Windows: `setContentProtection(true)` sets the display affinity that leaves a window out of
 *   screenshots and recordings (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004 and later).
 * - macOS: the same call sets the window's sharing type to none.
 * - Linux: the call does nothing (no display server offers it); the pill is small, sits above the
 *   top edge of the work area, and the agent is told nothing about it, but a screenshot may include it.
 */
export function createPillSurface(act: (action: PillAction) => void): PillSurface {
	const window = new BrowserWindow({
		show: false,
		width: PILL_WIDTH,
		height: PILL_COLLAPSED_HEIGHT,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		hasShadow: false,
		alwaysOnTop: true,
		title: 'Namzu working',
		webPreferences: {
			preload: join(dirname(fileURLToPath(import.meta.url)), '../pill-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	})
	window.setAlwaysOnTop(true, 'screen-saver')
	if (process.platform !== 'linux')
		window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	// Left out of what the screen shows anything that captures it, including the agent's own look.
	// `NAMZU_PILL_CAPTURABLE=1` leaves it in, only so a picture of the desktop can show the pill.
	const capturable = process.env.NAMZU_PILL_CAPTURABLE === '1'
	window.setContentProtection(!capturable)
	if (!capturable) markProtectedByDefault(window)
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
	window.webContents.on('will-navigate', (event) => event.preventDefault())
	const listener = (event: Electron.IpcMainEvent, action: unknown) => {
		if (event.sender !== window.webContents) return
		const read = readAction(action)
		if (read) act(read)
	}
	ipcMain.on('pill:action', listener)
	const ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillPage())}`)
	let last: PillView | undefined
	const flags = () => {
		if (!window.isDestroyed())
			window.webContents.send('pill:flags', {
				// Asked for on every platform; it takes effect where the system offers it.
				captureExcluded: !capturable,
				captureEffective:
					!capturable && (process.platform === 'win32' || process.platform === 'darwin'),
				focusable: window.isFocusable(),
			})
	}
	const push = () => {
		if (window.isDestroyed() || !last) return
		window.webContents.send('pill:view', last)
	}
	return {
		show(view) {
			last = view
			const cursor = screen.getCursorScreenPoint()
			const display = screen.getDisplayNearestPoint(cursor)
			window.setBounds(pillPlacement(display, pillHeight(view)))
			void ready.then(() => {
				flags()
				push()
				// Shown without activating it: the application being driven keeps focus.
				if (!window.isDestroyed() && !window.isVisible()) window.showInactive()
			})
			if (window.isVisible()) push()
		},
		destroy() {
			ipcMain.removeListener('pill:action', listener)
			if (!window.isDestroyed()) window.destroy()
		},
	}
}

function readAction(value: unknown): PillAction | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const raw = value as Record<string, unknown>
	if (raw.type === 'stop' && typeof raw.sessionId === 'string' && raw.sessionId.length <= 200)
		return { type: 'stop', sessionId: raw.sessionId }
	if (
		raw.type === 'answer' &&
		typeof raw.requestId === 'string' &&
		raw.requestId.length <= 200 &&
		(raw.choice === 'allow' || raw.choice === 'once' || raw.choice === 'deny')
	)
		return { type: 'answer', requestId: raw.requestId, choice: raw.choice }
	return undefined
}
