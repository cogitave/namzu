/**
 * The watcher's one-line input: a key opens it, what is typed is held here, Enter sends, Esc cancels.
 *
 * Pure: it takes the bytes a terminal in raw mode produces and says what changed. It never writes to the
 * screen and never sends anything; the watcher draws the line and does the sending. Nothing typed here is
 * read as a command: the text is the person's words for the model, whatever it starts with.
 */

/** The key that opens the line. */
export const SAY_KEY = 'm'

export type SayEvent =
	| { readonly kind: 'compose'; readonly text: string }
	| { readonly kind: 'cancel' }
	| { readonly kind: 'submit'; readonly text: string }
	| { readonly kind: 'leave' }

/** A character that may be part of a typed line: printable, no control, no direction or line-break mark. */
function typable(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0
	if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
	if (code === 0x2028 || code === 0x2029) return false
	if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)) return false
	if ((code >= 0x2060 && code <= 0x206f) || code === 0xfeff) return false
	return true
}

export class SayLine {
	#text: string | undefined

	/** Whether the line is open. */
	get open(): boolean {
		return this.#text !== undefined
	}

	/** What a chunk of raw terminal input does. Ctrl+C always leaves. */
	feed(chunk: string): SayEvent[] {
		const events: SayEvent[] = []
		if (chunk === '\x1b') {
			if (this.#text === undefined) return events
			this.#text = undefined
			return [{ kind: 'cancel' }]
		}
		// An arrow key or another escape sequence: not text, and not a key of ours.
		if (chunk.startsWith('\x1b')) return events
		for (const ch of chunk) {
			if (ch === '\x03') return [{ kind: 'leave' }]
			if (this.#text === undefined) {
				if (ch === SAY_KEY) {
					this.#text = ''
					events.push({ kind: 'compose', text: '' })
				}
				continue
			}
			if (ch === '\r' || ch === '\n') {
				const text = this.#text
				this.#text = undefined
				// What follows a line break in the same chunk is the rest of a paste: it is dropped, not typed as keys.
				if (text.trim().length === 0) events.push({ kind: 'cancel' })
				else events.push({ kind: 'submit', text })
				return events
			}
			if (ch === '\x7f' || ch === '\b') {
				this.#text = [...this.#text].slice(0, -1).join('')
				events.push({ kind: 'compose', text: this.#text })
			} else if (ch === '\x15') {
				this.#text = ''
				events.push({ kind: 'compose', text: '' })
			} else if (typable(ch)) {
				this.#text += ch
				events.push({ kind: 'compose', text: this.#text })
			}
		}
		return events
	}
}
