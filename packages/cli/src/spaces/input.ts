import type { Prefix } from './prefix.js'

/** A key the host reads itself: after the prefix, in a mode, or into a prompt. */
export type NavKey =
	| { readonly kind: 'up' }
	| { readonly kind: 'down' }
	| { readonly kind: 'left' }
	| { readonly kind: 'right' }
	| { readonly kind: 'tab' }
	| { readonly kind: 'backtab' }
	| { readonly kind: 'enter' }
	| { readonly kind: 'escape' }
	| { readonly kind: 'backspace' }
	| { readonly kind: 'char'; readonly char: string }

/**
 * What the keyboard is doing: `terminal` sends keys to the focused session,
 * `prefix` waits for the one key after the prefix, `resize` moves borders until
 * it is left, and `navigate` moves through the spaces.
 */
export type InputMode = 'terminal' | 'prefix' | 'resize' | 'navigate'

/** Where a host key came from: the key after the prefix, a mode, or text being typed. */
export type KeyContext = 'prefix' | 'resize' | 'navigate' | 'text'

/** What the router wants done with a piece of input. */
export type InputAction =
	| { readonly type: 'write'; readonly data: string }
	| { readonly type: 'mode'; readonly mode: InputMode }
	| { readonly type: 'nav'; readonly key: NavKey; readonly from: KeyContext }
	| { readonly type: 'mouse'; readonly mouse: MouseEvent }

/** A pointer event in screen cells, counted from 0. */
export interface MouseEvent {
	readonly kind: 'press' | 'release' | 'drag' | 'context' | 'wheel-up' | 'wheel-down' | 'other'
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
/** Control-C: clears the name being typed. */
export const CLEAR = '\x03'

/** Keys after the prefix that start a mode instead of running a command. */
const MODE_KEYS: Readonly<Record<string, InputMode>> = {
	r: 'resize',
	w: 'navigate',
}

/**
 * Splits what the keyboard sent into the host's own keys and bytes for the child.
 *
 * In terminal mode every byte goes to the child untouched except the prefix. A
 * bracketed paste is the exception to the exception: bytes between its markers are
 * pasted text and are never read as the prefix. After the prefix the next key is a
 * command for the host and the keyboard returns to the child; the prefix twice
 * sends one literal prefix byte, which is how a program that binds that key (the
 * composer moves its cursor left on ctrl+b) still receives it. `r` and `w` start
 * the resize and navigate modes, which last until escape or enter.
 */
export class InputRouter {
	private mode: InputMode = 'terminal'
	private pasting = false
	private carry = ''
	private capturing = false

	constructor(private readonly prefix: Prefix) {}

	get current(): InputMode {
		return this.mode
	}

	/** Hands the keyboard back to the session. */
	focus(): void {
		this.mode = 'terminal'
	}

	/**
	 * While on, every key goes to the host as text or a key (a name being typed, an
	 * answer to a question): escape and enter come through as keys, and the
	 * prefix is just a control byte nobody types.
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
		const enter = (mode: InputMode): void => {
			this.mode = mode
			actions.push({ type: 'mode', mode })
		}
		let i = 0
		while (i < chunk.length) {
			if (this.mode === 'terminal' && !this.capturing) {
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
			}
			const mouse = readMouse(chunk, i)
			if (mouse) {
				flush()
				actions.push({ type: 'mouse', mouse: mouse.event })
				i += mouse.length
				continue
			}
			if (this.mode === 'terminal' && !this.capturing) {
				const ch = chunk[i] as string
				if (ch === this.prefix.byte) {
					flush()
					enter('prefix')
				} else pending += ch
				i += 1
				continue
			}
			// Anywhere else the host consumes every key.
			const key = readKey(chunk.slice(i))
			i += key.length
			if (this.capturing) {
				// Control-C is the one control byte a name being typed reads: it clears the field.
				if (
					key.nav.kind === 'char' &&
					(key.nav.char === '' || (key.nav.char < ' ' && key.nav.char !== CLEAR))
				)
					continue
				actions.push({ type: 'nav', key: key.nav, from: 'text' })
				continue
			}
			if (key.text === this.prefix.byte) {
				const literal = this.mode === 'prefix'
				enter('terminal')
				if (literal) actions.push({ type: 'write', data: this.prefix.byte })
				continue
			}
			if (key.nav.kind === 'escape') {
				enter('terminal')
				continue
			}
			if (this.mode === 'prefix') {
				const started = key.nav.kind === 'char' ? MODE_KEYS[key.nav.char] : undefined
				enter(started ?? 'terminal')
				actions.push({ type: 'nav', key: key.nav, from: 'prefix' })
				continue
			}
			if (key.nav.kind === 'enter') {
				enter('terminal')
				continue
			}
			actions.push({
				type: 'nav',
				key: key.nav,
				from: this.mode as 'resize' | 'navigate',
			})
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
	else if ((code & 3) === 0) kind = code & 32 ? 'drag' : released ? 'release' : 'press'
	// The right button's press asks for a context menu; its motion and release mean nothing.
	else if ((code & 3) === 2 && !(code & 32) && !released) kind = 'context'
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
				code === 'A'
					? { kind: 'up' }
					: code === 'B'
						? { kind: 'down' }
						: code === 'C'
							? { kind: 'right' }
							: { kind: 'left' }
			return { length: arrow[0].length, text: arrow[0], nav }
		}
		if (text.startsWith('\x1b[Z')) return { length: 3, text: '\x1b[Z', nav: { kind: 'backtab' } }
		// Some other escape sequence: swallow it so its tail is not read as typed keys.
		const sequence = CSI.exec(text)
		if (sequence)
			return {
				length: sequence[0].length,
				text: sequence[0],
				nav: { kind: 'char', char: '' },
			}
		return { length: 1, text: first, nav: { kind: 'escape' } }
	}
	if (first === '\x7f' || first === '\b')
		return { length: 1, text: first, nav: { kind: 'backspace' } }
	if (first === '\r' || first === '\n') return { length: 1, text: first, nav: { kind: 'enter' } }
	if (first === '\t') return { length: 1, text: first, nav: { kind: 'tab' } }
	const code = first.codePointAt(0) as number
	const length = code > 0xffff ? 2 : 1
	return {
		length,
		text: text.slice(0, length),
		nav: { kind: 'char', char: text.slice(0, length) },
	}
}
