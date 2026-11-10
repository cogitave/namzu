/**
 * The pointer reports the fullscreen view asks the terminal for, and what is
 * done with them.
 *
 * The terminal is asked for button reports in the SGR encoding
 * (`ESC [ < b ; x ; y M` or `m`); every report is taken off the stream before
 * Ink reads it, because Ink does not know them and would type the bytes into
 * the composer. The wheel ones become calls to `onWheel`; with the full pointer
 * on, the left button's presses, drags and releases become calls to
 * `onPointer`, which is how text is selected. Reports arrive whole or split across two reads, so an unfinished
 * report at the end of a chunk waits for the next one. A lone ESC never waits:
 * that is the Escape key.
 */

import { MOUSE_OFF, mouseOn } from '../../workspaces/mouse.js'

export type WheelDirection = 'up' | 'down'

/** The left button: pressed, moved while held, or let go. `x` and `y` count from 1. */
export interface PointerReport {
	readonly kind: 'press' | 'drag' | 'release'
	readonly x: number
	readonly y: number
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the report starts with the ESC byte
const REPORT = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: the report starts with the ESC byte
const UNFINISHED = /\u001b\[<[\d;]*$/

/** Wheel notches are button codes 64 (up) and 65 (down), plus modifier bits. */
function wheelOf(code: number): WheelDirection | null {
	if ((code & 64) === 0) return null
	return (code & 3) === 0 ? 'up' : (code & 3) === 1 ? 'down' : null
}

export interface MouseFilter {
	/** Remove the reports from `chunk`; the rest passes through byte for byte. */
	feed(chunk: string): {
		readonly text: string
		readonly wheel: readonly WheelDirection[]
		readonly pointer: readonly PointerReport[]
	}
}

/** The left button's report for a button code, or null for anything else. */
function pointerOf(code: number, x: number, y: number, kind: string): PointerReport | null {
	if ((code & 3) !== 0 || (code & 64) !== 0) return null
	if (kind === 'm') return { kind: 'release', x, y }
	return { kind: (code & 32) !== 0 ? 'drag' : 'press', x, y }
}

export function createMouseFilter(): MouseFilter {
	let held = ''
	return {
		feed(chunk) {
			const input = held + chunk
			held = ''
			if (!input.includes('\u001b[<')) return { text: input, wheel: [], pointer: [] }
			const wheel: WheelDirection[] = []
			const pointer: PointerReport[] = []
			let text = input.replace(REPORT, (_all, code: string, x: string, y: string, kind: string) => {
				const direction = kind === 'M' ? wheelOf(Number(code)) : null
				if (direction) wheel.push(direction)
				else {
					const report = pointerOf(Number(code), Number(x), Number(y), kind)
					if (report) pointer.push(report)
				}
				return ''
			})
			const tail = UNFINISHED.exec(text)
			if (tail) {
				held = tail[0]
				text = text.slice(0, tail.index)
			}
			return { text, wheel, pointer }
		},
	}
}

interface WheelInput {
	read: (...args: never[]) => unknown
	isTTY?: boolean
}

interface WheelOutput {
	write: (text: string) => unknown
	isTTY?: boolean
}

/**
 * Switch pointer reporting on and filter it out of `stdin`. Returns the
 * function that undoes both and leaves the pointer off. Nothing is done for a
 * stream that is not a terminal. With `onPointer` the terminal is asked for
 * drags too, which is what selecting text needs; without it, the wheel only.
 */
export function installMouseWheel(
	stdin: WheelInput,
	stdout: WheelOutput,
	onWheel: (direction: WheelDirection) => void,
	onPointer?: (report: PointerReport) => void,
): () => void {
	if (stdin.isTTY !== true || stdout.isTTY !== true) return () => undefined
	const filter = createMouseFilter()
	const originalRead = stdin.read
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
		const filtered = filter.feed(chunk)
		for (const direction of filtered.wheel) onWheel(direction)
		if (onPointer) for (const report of filtered.pointer) onPointer(report)
		return filtered.text
	}
	write(mouseOn(onPointer ? 'full' : 'scroll'))
	let removed = false
	return () => {
		if (removed) return
		removed = true
		stdin.read = originalRead
		write(MOUSE_OFF)
	}
}

/**
 * What a dying process writes if the normal teardown never ran: pointer off,
 * paste mode off, cursor shown. The alternate screen is not left here: Ink
 * leaves it on its own exit path, and leaving it a second time would send the
 * cursor back to where it was saved when the screen was entered.
 */
export const FULLSCREEN_PANIC_RESET = `${MOUSE_OFF}\u001b[?2004l\u001b[?25h`
