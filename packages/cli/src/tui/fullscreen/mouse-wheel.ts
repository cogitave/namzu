/**
 * The pointer reports the fullscreen view asks the terminal for, and what is
 * done with them.
 *
 * Only the wheel matters in this mode. The terminal is asked for button
 * reports in the SGR encoding (`ESC [ < b ; x ; y M` or `m`); every report is
 * taken off the stream before Ink reads it, because Ink does not know them and
 * would type the bytes into the composer, and the wheel ones become calls to
 * `onWheel`. Reports arrive whole or split across two reads, so an unfinished
 * report at the end of a chunk waits for the next one. A lone ESC never waits:
 * that is the Escape key.
 */

import { MOUSE_OFF, mouseOn } from '../../workspaces/mouse.js'

export type WheelDirection = 'up' | 'down'

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
	feed(chunk: string): { readonly text: string; readonly wheel: readonly WheelDirection[] }
}

export function createMouseFilter(): MouseFilter {
	let held = ''
	return {
		feed(chunk) {
			const input = held + chunk
			held = ''
			if (!input.includes('\u001b[<')) return { text: input, wheel: [] }
			const wheel: WheelDirection[] = []
			let text = input.replace(REPORT, (_all, code: string, _x, _y, kind: string) => {
				const direction = kind === 'M' ? wheelOf(Number(code)) : null
				if (direction) wheel.push(direction)
				return ''
			})
			const tail = UNFINISHED.exec(text)
			if (tail) {
				held = tail[0]
				text = text.slice(0, tail.index)
			}
			return { text, wheel }
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
 * stream that is not a terminal.
 */
export function installMouseWheel(
	stdin: WheelInput,
	stdout: WheelOutput,
	onWheel: (direction: WheelDirection) => void,
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
		return filtered.text
	}
	write(mouseOn('scroll'))
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
