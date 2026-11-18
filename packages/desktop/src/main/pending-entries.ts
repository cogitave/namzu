/** The longest Quick Entry line Namzu starts a conversation from. */
export const QUICK_ENTRY_MAX_LENGTH = 4000

export interface PendingEntries {
	/** Lines typed into Quick Entry, oldest first. */
	quickEntries: string[]
	/** A global voice shortcut was pressed. */
	voice: boolean
}

/**
 * What a global shortcut asked of the app window. A window that does not exist yet cannot be told
 * anything, so the request waits here and the window asks for it once it is up.
 */
export class PendingQueue {
	private lines: string[] = []
	private voice = false

	/** Keep a line from Quick Entry; returns whether anything was kept. */
	addLine(text: string): boolean {
		const line = text.trim().slice(0, QUICK_ENTRY_MAX_LENGTH)
		if (!line) return false
		this.lines.push(line)
		return true
	}

	addVoice(): void {
		this.voice = true
	}

	take(): PendingEntries {
		const taken = { quickEntries: this.lines, voice: this.voice }
		this.lines = []
		this.voice = false
		return taken
	}
}
