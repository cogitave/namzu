import { attentionDescription } from '../shared/attention-state.js'

/** The slice of a window the controller touches. */
export interface AttentionWindow {
	isDestroyed(): boolean
	isFocused(): boolean
	flashFrame(flash: boolean): void
	setOverlayIcon(image: unknown, description: string): void
}

export interface AttentionHost {
	platform: NodeJS.Platform
	windows(): AttentionWindow[]
	/** `app.setBadgeCount`; the controller never calls it on Windows, where it does nothing. */
	setBadgeCount(count: number): void
	/** macOS only: bounce the dock icon once; returns an id that can cancel it. */
	bounceDock?(): number
	cancelDockBounce?(id: number): void
	/** The Windows taskbar overlay for a count. */
	overlayImage?(count: number): unknown
	/** Read on every change: the setting can change while the app runs. */
	enabled(): boolean
}

/**
 * Tells the person, from outside the window, that a conversation is waiting for them: a count on
 * the app icon and one flash of the taskbar or dock. It signals only while no window is focused,
 * flashes only on the change from nothing needing the person to something, and lets go as soon as a
 * window is focused, nothing needs the person, or the setting is turned off. No banner, no sound.
 */
export class AttentionSignals {
	private ids: readonly string[] = []
	private signalled = false
	private shownCount = 0
	private bounce: number | undefined

	constructor(private readonly host: AttentionHost) {}

	/** The conversations that need the person changed. */
	update(ids: readonly string[]): void {
		this.ids = ids
		this.refresh()
	}

	/** A window gained or lost focus, or the setting changed: apply the held state again. */
	refresh(): void {
		const count = this.ids.length
		const focused = this.host
			.windows()
			.some((window) => !window.isDestroyed() && window.isFocused())
		if (!this.host.enabled() || count === 0 || focused) {
			this.clear()
			return
		}
		if (count !== this.shownCount) this.show(count)
		if (!this.signalled) {
			this.signalled = true
			this.flash()
		}
	}

	/** Lets go of everything shown. Safe to call when nothing is. */
	clear(): void {
		if (this.shownCount > 0) this.show(0)
		if (!this.signalled) return
		this.signalled = false
		if (this.host.platform === 'win32') for (const window of this.live()) window.flashFrame(false)
		if (this.bounce !== undefined) this.host.cancelDockBounce?.(this.bounce)
		this.bounce = undefined
	}

	private show(count: number): void {
		this.shownCount = count
		if (this.host.platform === 'win32') {
			const image = count > 0 ? (this.host.overlayImage?.(count) ?? null) : null
			for (const window of this.live()) window.setOverlayIcon(image, attentionDescription(count))
		} else this.host.setBadgeCount(count)
	}

	private flash(): void {
		if (this.host.platform === 'win32') for (const window of this.live()) window.flashFrame(true)
		else if (this.host.platform === 'darwin') this.bounce = this.host.bounceDock?.()
	}

	private live(): AttentionWindow[] {
		return this.host.windows().filter((window) => !window.isDestroyed())
	}
}
