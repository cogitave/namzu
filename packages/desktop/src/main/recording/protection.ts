/**
 * While a recording runs, every Namzu window is left out of what the screen shows: neither the pill
 * nor the conversation may appear in the pictures. Windows 10 2004 and later honour
 * `setContentProtection` (display affinity "exclude from capture"); macOS sets the sharing type to
 * none. This registry applies it to every window it knows, including one that opens mid-recording,
 * and puts each back to what it was when the recording is over.
 */
export interface ProtectableWindow {
	setContentProtection(enabled: boolean): void
	isDestroyed(): boolean
}

interface Entry {
	window: ProtectableWindow
	/** What the window does when no recording runs: the pill is always protected, the others are not. */
	baseline: boolean
}

export class ContentProtection {
	private readonly entries = new Set<Entry>()
	private engaged = false

	/** A window to protect during a recording. */
	add(window: ProtectableWindow, baseline = false): void {
		const entry = { window, baseline }
		this.entries.add(entry)
		if (this.engaged) this.apply(entry, true)
	}

	remove(window: ProtectableWindow): void {
		for (const entry of this.entries) if (entry.window === window) this.entries.delete(entry)
	}

	get active(): boolean {
		return this.engaged
	}

	engage(): void {
		this.engaged = true
		for (const entry of this.entries) this.apply(entry, true)
	}

	release(): void {
		this.engaged = false
		for (const entry of this.entries) this.apply(entry, entry.baseline)
	}

	/** Windows that are no longer there are forgotten. */
	private apply(entry: Entry, enabled: boolean): void {
		if (entry.window.isDestroyed()) {
			this.entries.delete(entry)
			return
		}
		try {
			entry.window.setContentProtection(enabled)
		} catch {
			// A window that cannot be protected is a window the person has to know about; the
			// session treats a failed engage as a refusal to record, so nothing is hidden here.
			throw new Error('A Namzu window could not be hidden from the recording.')
		}
	}
}
