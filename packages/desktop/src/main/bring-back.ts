/** The slice of a window the raise touches. */
export interface RaiseWindow {
	isDestroyed(): boolean
	isFocused(): boolean
	isMinimized(): boolean
	isVisible(): boolean
	/** Above the other windows without taking focus; the person may be typing in one of them. */
	moveTop(): void
	flashFrame(flash: boolean): void
}

/**
 * Brings Namzu's window back once when something needs it and an application it was driving covers
 * it: the window moves above the others without taking focus, and its taskbar button flashes once.
 * It does this once per wait; it re-arms when a Namzu window is focused, which is when the person
 * has seen it. A window that is minimised only flashes, since restoring it would jump over the
 * application the person is looking at.
 */
export class BringBack {
	private armed = true

	constructor(private readonly windows: () => RaiseWindow[]) {}

	/** Something needs the main window. Returns whether it acted. */
	needed(): boolean {
		const live = this.windows().filter((window) => !window.isDestroyed())
		if (live.length === 0) return false
		if (live.some((window) => window.isFocused())) {
			this.armed = true
			return false
		}
		if (!this.armed) return false
		this.armed = false
		for (const window of live) {
			if (window.isVisible() && !window.isMinimized()) window.moveTop()
			window.flashFrame(true)
		}
		return true
	}

	/** A Namzu window was focused: the person has it. */
	focused(): void {
		this.armed = true
		for (const window of this.windows()) if (!window.isDestroyed()) window.flashFrame(false)
	}
}
