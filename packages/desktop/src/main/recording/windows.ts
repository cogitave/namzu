import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, type Display, ipcMain } from 'electron'
import {
	type ChooserAnswer,
	type ChooserInit,
	type PillView,
	RECORDING_LIMITS,
} from '../../shared/recording-protocol.js'
import {
	CHOOSER_HEIGHT,
	CHOOSER_WIDTH,
	PILL_HEIGHT,
	PILL_WIDTH,
	chooserPage,
	pillPage,
} from './pages.js'
import type { ContentProtection } from './protection.js'
import type { PillOutput } from './session.js'

/**
 * The chooser and the pill as Electron windows. Both are sandboxed, content-protected and load a
 * `data:` page with no network and no navigation. The answers they send are read here, key by key,
 * and anything else is dropped.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(here, '../../recording-preload.cjs')

export type PillAction = 'pause' | 'resume' | 'done' | 'discard' | 'reconnect'

export function readChooserAnswer(value: unknown): ChooserAnswer | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const raw = value as Record<string, unknown>
	if (raw.type === 'cancel' || raw.type === 'open-settings' || raw.type === 'continue')
		return { type: raw.type }
	if (
		raw.type === 'start' &&
		typeof raw.displayId === 'string' &&
		raw.displayId.length <= 100 &&
		typeof raw.voice === 'boolean' &&
		typeof raw.microphone === 'string' &&
		raw.microphone.length <= 400
	)
		return { type: 'start', displayId: raw.displayId, voice: raw.voice, microphone: raw.microphone }
	return undefined
}

export function readPillAction(value: unknown): PillAction | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const type = (value as Record<string, unknown>).type
	return type === 'pause' ||
		type === 'resume' ||
		type === 'done' ||
		type === 'discard' ||
		type === 'reconnect'
		? type
		: undefined
}

/** Start ignores input that arrives sooner than `inputProtectionMs` after the chooser opened. */
export class ChooserGate {
	private readonly openedAt: number
	constructor(
		private readonly clock: () => number,
		private readonly protectionMs: number = RECORDING_LIMITS.inputProtectionMs,
	) {
		this.openedAt = clock()
	}
	accept(answer: ChooserAnswer): ChooserAnswer | undefined {
		if (answer.type === 'start' && this.clock() - this.openedAt < this.protectionMs)
			return undefined
		return answer
	}
}

/** The pill's place: top centre of the work area; at the bottom while the pointer is near the top. */
export function pillBounds(
	display: Pick<Display, 'workArea'>,
	pointerNear: boolean,
): { x: number; y: number; width: number; height: number } {
	const area = display.workArea
	return {
		x: Math.round(area.x + (area.width - PILL_WIDTH) / 2),
		y: pointerNear ? area.y + area.height - PILL_HEIGHT - 12 : area.y + 10,
		width: PILL_WIDTH,
		height: PILL_HEIGHT,
	}
}

/** True when the pointer is within `margin` of the rectangle. */
export function pointerNear(
	point: { x: number; y: number },
	rect: { x: number; y: number; width: number; height: number },
	margin = 60,
): boolean {
	return (
		point.x >= rect.x - margin &&
		point.x <= rect.x + rect.width + margin &&
		point.y >= rect.y - margin &&
		point.y <= rect.y + rect.height + margin
	)
}

function webPreferences() {
	return {
		preload: PRELOAD,
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		webSecurity: true,
	}
}

function lock(window: BrowserWindow): void {
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
	window.webContents.on('will-navigate', (event) => event.preventDefault())
}

/** Shows the chooser over `parent` and answers with what the person pressed. */
export function showChooser(options: {
	parent: BrowserWindow | undefined
	init: ChooserInit
	protection: ContentProtection
	clock: () => number
}): Promise<ChooserAnswer> {
	const { parent, init, protection } = options
	return new Promise((resolve) => {
		const window = new BrowserWindow({
			...(parent && !parent.isDestroyed() ? { parent } : {}),
			modal: Boolean(parent && !parent.isDestroyed()),
			show: false,
			width: CHOOSER_WIDTH,
			height: CHOOSER_HEIGHT,
			frame: false,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			title: 'Record your screen',
			webPreferences: webPreferences(),
		})
		protection.add(window, true)
		window.setContentProtection(true)
		lock(window)
		const gate = new ChooserGate(options.clock, init.inputProtectionMs)
		let settled = false
		const settle = (answer: ChooserAnswer) => {
			if (settled) return
			settled = true
			ipcMain.removeListener('recording:chooser-answer', listener)
			protection.remove(window)
			if (!window.isDestroyed()) window.destroy()
			resolve(answer)
		}
		const listener = (event: Electron.IpcMainEvent, value: unknown) => {
			if (event.sender !== window.webContents) return
			const answer = readChooserAnswer(value)
			const accepted = answer ? gate.accept(answer) : undefined
			if (accepted) settle(accepted)
		}
		ipcMain.on('recording:chooser-answer', listener)
		window.webContents.on('before-input-event', (event, input) => {
			if (input.type === 'keyDown' && input.key === 'Escape') {
				event.preventDefault()
				settle({ type: 'cancel' })
			}
		})
		window.on('closed', () => settle({ type: 'cancel' }))
		void window
			.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chooserPage())}`)
			.then(() => {
				if (window.isDestroyed()) return
				window.webContents.send('recording:chooser', init)
				window.show()
			})
	})
}

/** The recorder pill: always on top, never taking focus, hidden from every picture. */
export class PillWindow implements PillOutput {
	private window: BrowserWindow | undefined
	private ready: Promise<void> | undefined
	private last: PillView | undefined
	private display: Display | undefined
	private aside = false
	private readonly listener: (event: Electron.IpcMainEvent, value: unknown) => void

	constructor(
		private readonly protection: ContentProtection,
		private readonly act: (action: PillAction) => void,
		private readonly pickDisplay: () => Display,
	) {
		this.listener = (event, value) => {
			if (!this.window || event.sender !== this.window.webContents) return
			const action = readPillAction(value)
			if (action) this.act(action)
		}
	}

	private ensure(): BrowserWindow {
		if (this.window && !this.window.isDestroyed()) return this.window
		const window = new BrowserWindow({
			show: false,
			width: PILL_WIDTH,
			height: PILL_HEIGHT,
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
			title: 'Namzu recording',
			webPreferences: webPreferences(),
		})
		window.setAlwaysOnTop(true, 'screen-saver')
		if (process.platform !== 'linux')
			window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
		this.protection.add(window, true)
		window.setContentProtection(true)
		lock(window)
		ipcMain.on('recording:pill-action', this.listener)
		this.ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillPage())}`)
		this.window = window
		return window
	}

	/** Picks the display the pill sits on and shows it there; called when a recording starts. */
	place(display: Display): void {
		this.display = display
	}

	/** Moves the pill out of the pointer's way, or back. */
	setAside(aside: boolean): void {
		if (aside === this.aside) return
		this.aside = aside
		this.reposition()
	}

	get bounds(): { x: number; y: number; width: number; height: number } | undefined {
		return this.window && !this.window.isDestroyed() ? this.window.getBounds() : undefined
	}

	private reposition(): void {
		if (!this.window || this.window.isDestroyed()) return
		const display = this.display ?? this.pickDisplay()
		this.window.setBounds(pillBounds(display, this.aside))
	}

	show(view: PillView): void {
		this.last = view
		const window = this.ensure()
		this.reposition()
		void this.ready?.then(() => {
			if (window.isDestroyed()) return
			window.webContents.send('recording:pill', this.last)
			if (!window.isVisible()) window.showInactive()
		})
	}

	hide(): void {
		this.last = undefined
		if (!this.window) return
		ipcMain.removeListener('recording:pill-action', this.listener)
		this.protection.remove(this.window)
		if (!this.window.isDestroyed()) this.window.destroy()
		this.window = undefined
		this.ready = undefined
	}
}
