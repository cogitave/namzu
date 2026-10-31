import type { Prefix } from './prefix.js'

/** A key the navigate mode understands. */
export type NavKey =
	| { readonly kind: 'up' }
	| { readonly kind: 'down' }
	| { readonly kind: 'enter' }
	| { readonly kind: 'escape' }
	| { readonly kind: 'char'; readonly char: string }

/** What the router wants done with a piece of input. */
export type InputAction =
	| { readonly type: 'write'; readonly data: string }
	| { readonly type: 'mode'; readonly mode: 'terminal' | 'navigate' }
	| { readonly type: 'nav'; readonly key: NavKey }

const ESC = String.fromCharCode(27)
const ARROW = new RegExp(`^${ESC}[[O]([ABCD])`, 'u')
const CSI = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'u')
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

	constructor(private readonly prefix: Prefix) {}

	get current(): 'terminal' | 'navigate' {
		return this.mode
	}

	feed(chunk: string): InputAction[] {
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
			const rest = chunk.slice(i)
			const key = readKey(rest)
			i += key.length
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
	if (first === '\r' || first === '\n') return { length: 1, text: first, nav: { kind: 'enter' } }
	const code = first.codePointAt(0) as number
	const length = code > 0xffff ? 2 : 1
	return { length, text: text.slice(0, length), nav: { kind: 'char', char: text.slice(0, length) } }
}
