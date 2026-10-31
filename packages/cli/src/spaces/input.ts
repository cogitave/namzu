import type { Prefix } from './prefix.js'

/** A key the navigate mode understands. */
export type NavKey =
	| { readonly kind: 'up' }
	| { readonly kind: 'down' }
	| { readonly kind: 'enter' }
	| { readonly kind: 'escape' }
	| { readonly kind: 'backspace' }
	| { readonly kind: 'char'; readonly char: string }

/** What the router wants done with a piece of input. */
export type InputAction =
	| { readonly type: 'write'; readonly data: string }
	| { readonly type: 'mode'; readonly mode: 'terminal' | 'navigate' }
	| { readonly type: 'nav'; readonly key: NavKey }
	| { readonly type: 'mouse'; readonly mouse: MouseEvent }

/** A pointer event in screen cells, counted from 0. */
export interface MouseEvent {
	readonly kind: 'press' | 'release' | 'wheel-up' | 'wheel-down' | 'other'
	readonly x: number
	readonly y: number
}

const ESC = String.fromCharCode(27)
const ARROW = new RegExp(`^${ESC}[[O]([ABCD])`, 'u')
const CSI = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'u')
const MOUSE = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'u')
const MOUSE_PARTIAL = new RegExp(`${ESC}(\\[(<[0-9;]*)?)?$`, 'u')
const PASTE_BEGIN = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Splits what the keyboard sent into the host's own keys and bytes for the child.
 *
 * In terminal mode every byte goes to the child untouched except the prefix. A
 * bracketed paste is the exception to the exception: bytes between its markers are
 * pasted text and are never read as the prefix. In navigate mode the host consumes
 * everything. Pressing the prefix straight after entering navigate mode sends one
 * literal prefix byte to the child, which is how a program that binds that key
 * (the composer moves its cursor left on ctrl+b) still receives it; the same key
 * after any other navigate key only leaves the mode.
 */
export class InputRouter {
	private mode: 'terminal' | 'navigate' = 'terminal'
	private untouched = false
	private pasting = false
	private carry = ''
	private capturing = false

	constructor(private readonly prefix: Prefix) {}

	get current(): 'terminal' | 'navigate' {
		return this.mode
	}

	/** Hands the keyboard to the session, as enter does. */
	focus(): void {
		this.mode = 'terminal'
		this.untouched = false
	}

	/**
	 * While on, navigate mode hands every key to the host as text (a folder or a
	 * name being typed): escape and enter come through as keys and do not leave
	 * the mode, and the prefix is just a control byte nobody types.
	 */
	capture(on: boolean): void {
		this.capturing = on
	}

	feed(input: string): InputAction[] {
		let chunk = this.carry + input
		this.carry = ''
		// A mouse report cut in two by the terminal waits for its other half.
		const cut = this.pasting ? null : MOUSE_PARTIAL.exec(chunk)
		if (cut?.[2] !== undefined) {
			this.carry = cut[0]
			chunk = chunk.slice(0, cut.index)
		}
		const actions: InputAction[] = []
		let pending = ''
		const flush = (): void => {
			if (pending !== '') actions.push({ type: 'write', data: pending })
			pending = ''
		}
		let i = 0
		while (i < chunk.length) {
			if (this.mode === 'terminal') {
				if (this.pasting) {
					const end = chunk.indexOf(PASTE_END, i)
					if (end < 0) {
						pending += chunk.slice(i)
						i = chunk.length
					} else {
						pending += chunk.slice(i, end + PASTE_END.length)
						i = end + PASTE_END.length
						this.pasting = false
					}
					continue
				}
				if (chunk.startsWith(PASTE_BEGIN, i)) {
					pending += PASTE_BEGIN
					i += PASTE_BEGIN.length
					this.pasting = true
					continue
				}
				const mouse = readMouse(chunk, i)
				if (mouse) {
					flush()
					actions.push({ type: 'mouse', mouse: mouse.event })
					i += mouse.length
					continue
				}
				const ch = chunk[i] as string
				if (ch === this.prefix.byte) {
					flush()
					this.mode = 'navigate'
					this.untouched = true
					actions.push({ type: 'mode', mode: 'navigate' })
				} else pending += ch
				i += 1
				continue
			}
			// Navigate mode: the host consumes every key.
			const mouse = readMouse(chunk, i)
			if (mouse) {
				actions.push({ type: 'mouse', mouse: mouse.event })
				i += mouse.length
				continue
			}
			const rest = chunk.slice(i)
			const key = readKey(rest)
			i += key.length
			if (this.capturing) {
				if (key.nav.kind === 'char' && (key.nav.char === '' || key.nav.char < ' ')) continue
				actions.push({ type: 'nav', key: key.nav })
				continue
			}
			if (key.text === this.prefix.byte) {
				this.mode = 'terminal'
				actions.push({ type: 'mode', mode: 'terminal' })
				if (this.untouched) actions.push({ type: 'write', data: this.prefix.byte })
				continue
			}
			this.untouched = false
			if (key.nav.kind === 'escape') {
				this.mode = 'terminal'
				actions.push({ type: 'mode', mode: 'terminal' })
				continue
			}
			actions.push({ type: 'nav', key: key.nav })
			// Enter and `l` hand the keyboard back to the selected session.
			if (key.nav.kind === 'enter' || (key.nav.kind === 'char' && key.nav.char === 'l')) {
				this.mode = 'terminal'
				actions.push({ type: 'mode', mode: 'terminal' })
			}
		}
		flush()
		return actions
	}
}

interface ReadKey {
	readonly length: number
	readonly text: string
	readonly nav: NavKey
}

function readMouse(chunk: string, at: number): { length: number; event: MouseEvent } | undefined {
	if (chunk[at] !== ESC) return undefined
	const match = MOUSE.exec(chunk.slice(at))
	if (!match) return undefined
	const code = Number(match[1])
	const x = Number(match[2]) - 1
	const y = Number(match[3]) - 1
	const released = match[4] === 'm'
	let kind: MouseEvent['kind'] = 'other'
	if (code & 64) kind = (code & 3) === 0 ? 'wheel-up' : (code & 3) === 1 ? 'wheel-down' : 'other'
	else if ((code & 3) === 0 && !(code & 32)) kind = released ? 'release' : 'press'
	return { length: match[0].length, event: { kind, x, y } }
}

/** Reads one key from the front of `text`. Unknown escape sequences are swallowed whole. */
function readKey(text: string): ReadKey {
	const first = text[0] as string
	if (first === '\x1b') {
		const arrow = ARROW.exec(text)
		if (arrow) {
			const code = arrow[1]
			const nav: NavKey =
				code === 'A' ? { kind: 'up' } : code === 'B' ? { kind: 'down' } : { kind: 'char', char: '' }
			return { length: arrow[0].length, text: arrow[0], nav }
		}
		// Some other escape sequence: swallow it so its tail is not read as typed keys.
		const sequence = CSI.exec(text)
		if (sequence)
			return { length: sequence[0].length, text: sequence[0], nav: { kind: 'char', char: '' } }
		return { length: 1, text: first, nav: { kind: 'escape' } }
	}
	if (first === '\x7f' || first === '\b')
		return { length: 1, text: first, nav: { kind: 'backspace' } }
	if (first === '\r' || first === '\n') return { length: 1, text: first, nav: { kind: 'enter' } }
	const code = first.codePointAt(0) as number
	const length = code > 0xffff ? 2 : 1
	return { length, text: text.slice(0, length), nav: { kind: 'char', char: text.slice(0, length) } }
}
