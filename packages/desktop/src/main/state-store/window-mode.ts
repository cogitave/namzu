import type { StateStore } from './store.js'

/** Whether a window was maximized or full screen when it last closed. */
export interface WindowMode {
	readonly maximized: boolean
	readonly fullscreen: boolean
}

const keyOf = (windowId: string) => `window.mode:${windowId}`

export function readWindowMode(store: StateStore, windowId: string): WindowMode {
	const none = { maximized: false, fullscreen: false }
	const raw = store.get(keyOf(windowId))
	if (!raw) return none
	try {
		const value = JSON.parse(raw) as Record<string, unknown>
		return { maximized: value.maximized === true, fullscreen: value.fullscreen === true }
	} catch {
		return none
	}
}

/** Remembers the mode; a window in neither mode drops its entry, so the store holds only what differs. */
export function writeWindowMode(store: StateStore, windowId: string, mode: WindowMode): void {
	if (!mode.maximized && !mode.fullscreen) store.remove(keyOf(windowId))
	else store.set(keyOf(windowId), JSON.stringify(mode))
}

/** The part of a window the mode needs; a test passes a plain object. */
export interface ModeWindow {
	isDestroyed(): boolean
	isMaximized(): boolean
	isFullScreen(): boolean
	maximize(): void
	setFullScreen(flag: boolean): void
}

/** Puts a window back the way it was: full screen wins over maximized, as it does on screen. */
export function applyWindowMode(window: ModeWindow, mode: WindowMode): void {
	if (window.isDestroyed()) return
	if (mode.fullscreen) window.setFullScreen(true)
	else if (mode.maximized) window.maximize()
}

export function captureWindowMode(window: ModeWindow): WindowMode {
	return window.isDestroyed()
		? { maximized: false, fullscreen: false }
		: { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
}
