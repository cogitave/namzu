/**
 * Where a typed command's expanded text waits between the two passes of its
 * line: the first pass runs the shell commands the text holds, then submits
 * the same line again, and the second pass picks the text up.
 *
 * The text is good for that one resubmission. If the line is turned aside on
 * the way (queued behind a busy turn, blocked), nothing picks it up, and the
 * same line typed later must run its commands again, not reuse old output.
 */

export interface ShellExpansionEntry {
	readonly line: string
	readonly text: string
	used: boolean
}

export interface ShellExpansionSlot {
	/** The entry now held, for `settle`. */
	put(line: string, text: string): ShellExpansionEntry
	/** The text kept for this exact line, marking it picked up. */
	take(line: string): string | undefined
	/** Whether the held text is for this line (a second pass, however it ends). */
	holds(line: string): boolean
	/**
	 * Called right after the resubmission returns: an entry nobody picked up
	 * was turned aside, so it is dropped.
	 */
	settle(entry: ShellExpansionEntry): void
	clear(): void
}

export function createShellExpansionSlot(): ShellExpansionSlot {
	let held: ShellExpansionEntry | null = null
	return {
		put(line, text) {
			held = { line, text, used: false }
			return held
		},
		take(line) {
			if (held === null || held.line !== line) return undefined
			held.used = true
			return held.text
		},
		holds: (line) => held?.line === line,
		settle(entry) {
			if (held === entry && !entry.used) held = null
		},
		clear() {
			held = null
		},
	}
}
