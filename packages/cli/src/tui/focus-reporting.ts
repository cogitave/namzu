/**
 * Terminal focus reporting (DEC private mode 1004).
 *
 * With the mode on, the terminal writes `ESC [ I` when its window gains focus
 * and `ESC [ O` when it loses it. Ink does not know these reports: left in the
 * stream, a report reaches `useInput` as the text `[I` or `[O` and is typed
 * into the composer. So the stream Ink reads is wrapped: every chunk is
 * stripped of complete reports before Ink sees it, and the reports become
 * calls to `onFocus`.
 *
 * The mode is held exactly while raw mode is held: switched on when Ink takes
 * raw mode, off when it lets go (which also covers the external editor, which
 * runs with raw mode released), and always off when the wrapper is removed.
 * Nothing is written to a stream that is not a terminal.
 */

export const FOCUS_REPORTING_ENABLE = '\u001b[?1004h'
export const FOCUS_REPORTING_DISABLE = '\u001b[?1004l'

const FOCUS_IN = '\u001b[I'
const FOCUS_OUT = '\u001b[O'

export type FocusEvent = 'in' | 'out'

/**
 * Remove complete focus reports from a chunk. Everything else stays
 * byte-identical: a lone ESC, arrow keys, other control sequences and text
 * that merely looks like a report (`[I` with no ESC) are left alone.
 */
export function stripFocusReports(chunk: string): {
	readonly text: string
	readonly events: readonly FocusEvent[]
} {
	if (!chunk.includes('\u001b[')) return { text: chunk, events: [] }
	const events: FocusEvent[] = []
	let text = ''
	let from = 0
	for (let i = 0; i < chunk.length - 2; i += 1) {
		if (chunk.charCodeAt(i) !== 0x1b) continue
		const token = chunk.slice(i, i + 3)
		if (token !== FOCUS_IN && token !== FOCUS_OUT) continue
		text += chunk.slice(from, i)
		events.push(token === FOCUS_IN ? 'in' : 'out')
		from = i + 3
		i += 2
	}
	return { text: text + chunk.slice(from), events }
}

interface FocusInput {
	read: (...args: never[]) => unknown
	setRawMode?: (mode: boolean) => unknown
	isTTY?: boolean
}

interface FocusOutput {
	write: (text: string) => unknown
	isTTY?: boolean
}

/**
 * Wrap `stdin` so focus reports are reported through `onFocus` and never
 * reach the reader, and keep the mode on while raw mode is held. Returns the
 * function that undoes it (and switches the mode off). Does nothing, and
 * returns a no-op, when either stream is not a terminal.
 */
export function installFocusReporting(
	stdin: FocusInput,
	stdout: FocusOutput,
	onFocus: (focused: boolean) => void,
): () => void {
	if (stdin.isTTY !== true || stdout.isTTY !== true || typeof stdin.setRawMode !== 'function') {
		return () => undefined
	}
	const originalRead = stdin.read
	const originalSetRawMode = stdin.setRawMode
	let enabled = false
	const write = (text: string): void => {
		try {
			stdout.write(text)
		} catch {
			// The terminal is gone; there is nobody to tell.
		}
	}
	stdin.read = function patchedRead(this: unknown, ...args: never[]): unknown {
		const chunk = originalRead.apply(this, args)
		if (typeof chunk !== 'string') return chunk
		const stripped = stripFocusReports(chunk)
		for (const event of stripped.events) onFocus(event === 'in')
		return stripped.text
	}
	stdin.setRawMode = function patchedSetRawMode(this: unknown, mode: boolean): unknown {
		const result = originalSetRawMode.call(this, mode)
		if (mode && !enabled) {
			enabled = true
			write(FOCUS_REPORTING_ENABLE)
		} else if (!mode && enabled) {
			enabled = false
			write(FOCUS_REPORTING_DISABLE)
		}
		return result
	}
	let removed = false
	return () => {
		if (removed) return
		removed = true
		stdin.read = originalRead
		stdin.setRawMode = originalSetRawMode
		// Always written, even if the mode was never seen on: it is harmless and
		// leaves the terminal as found.
		enabled = false
		write(FOCUS_REPORTING_DISABLE)
	}
}
