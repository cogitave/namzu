/**
 * Keep a bracketed-paste marker whole when the terminal's bytes arrive in pieces.
 *
 * A terminal wraps a paste in `ESC [ 2 0 0 ~` and `ESC [ 2 0 1 ~`. Ink assembles a
 * marker split across two reads of standard input, but only briefly: an incomplete
 * escape sequence is flushed as typed text after 20 ms (its exemption covers just the
 * exact pending `ESC [ 2 0 0` and anything already inside a paste). On a slow or lossy
 * link the second part can arrive later than that, and the rest of the marker lands in
 * the message box as `[200~` and `[201~`.
 *
 * So the stream Ink reads is wrapped, as `focus-reporting.ts` wraps it. When a read ends
 * with a proper prefix of a marker that is already past `ESC [`, those bytes are held
 * back, and everything before them goes on. They are released
 *
 *  - joined to the next read, which then either completes the marker or shows the
 *    prefix was something else, and Ink sees the bytes exactly as the terminal sent
 *    them; or
 *  - when a bound passes with nothing more, so a terminal that died mid-marker cannot
 *    keep keys back for good. The bytes then reach Ink unchanged, and from there it
 *    treats them as it always has.
 *
 * The bound depends on what the prefix can still be:
 *
 *  - `ESC [` and `ESC [ 2` are also the start of an arrow key and of Insert (`ESC [ 2 ~`).
 *    The terminal writes those whole, so a pause inside one is only a slow link, but
 *    they are the keys a person is watching, so they wait briefly (SHARED_PREFIX_MS).
 *  - `ESC [ 2 0`, `ESC [ 2 0 0` and `ESC [ 2 0 1` start nothing but a paste marker.
 *    No key produces them, so waiting costs no keypress and they wait much longer
 *    (MARKER_ONLY_PREFIX_MS).
 *
 * A lone `ESC` is never held: it is the Escape key, and it is recognised on Ink's own
 * schedule. The same bytes arrive when a link splits a marker right after its `ESC`
 * and pauses, so that one split cannot be told from a person pressing Escape and then
 * typing, and is left to Ink. Every complete sequence (an arrow, Alt plus a letter,
 * Insert, a function key) is not a prefix of anything and passes at once.
 */

const ESC = '\u001b'
const MARKERS = [`${ESC}[200~`, `${ESC}[201~`] as const

/** How long `ESC [` or `ESC [ 2` waits for its next byte before going on to Ink. */
export const SHARED_PREFIX_MS = 200
/** How long a prefix that can only be a paste marker waits for its next byte. */
export const MARKER_ONLY_PREFIX_MS = 2000

/** The length of the tail of `text` that is a proper prefix of a marker and at least `ESC [`. */
function heldTailLength(text: string): number {
	const longest = Math.min(text.length, MARKERS[0].length - 1)
	for (let length = longest; length >= 2; length -= 1) {
		const tail = text.slice(-length)
		if (MARKERS.some((marker) => marker.startsWith(tail))) return length
	}
	return 0
}

export interface PasteMarkerGuard {
	/**
	 * Take what a read returned (`null` when it returned nothing) and answer with what
	 * the reader may have now, or `null` when nothing is ready.
	 */
	read(chunk: string | null): string | null
	/** Drop the timer. Held bytes are not returned. */
	dispose(): void
}

/**
 * The hold itself, with no stream in it. `onRelease` is called when a bound passes
 * and the held bytes became readable by the next `read(null)`.
 */
export function createPasteMarkerGuard(onRelease: () => void): PasteMarkerGuard {
	let held = ''
	let ready = ''
	let timer: ReturnType<typeof setTimeout> | undefined
	const stop = (): void => {
		if (timer === undefined) return
		clearTimeout(timer)
		timer = undefined
	}
	return {
		read(chunk) {
			if (chunk === null) {
				const out = ready
				ready = ''
				return out === '' ? null : out
			}
			stop()
			const input = ready + held + chunk
			ready = ''
			held = ''
			const keep = heldTailLength(input)
			if (keep > 0) {
				held = input.slice(input.length - keep)
				const bound = keep >= 4 ? MARKER_ONLY_PREFIX_MS : SHARED_PREFIX_MS
				timer = setTimeout(() => {
					timer = undefined
					ready = held
					held = ''
					onRelease()
				}, bound)
			}
			const out = input.slice(0, input.length - keep)
			return out === '' ? null : out
		},
		dispose() {
			stop()
		},
	}
}

interface GuardedInput {
	read: (...args: never[]) => unknown
	emit: (event: 'readable') => unknown
}

/**
 * Wrap `stdin.read` so a split paste marker reaches the reader whole. When a bound
 * passes, the stream is told it is readable again, which is how Ink learns that the
 * held bytes are there. Returns the function that undoes it.
 */
export function installPasteMarkerGuard(stdin: GuardedInput): () => void {
	const originalRead = stdin.read
	const guard = createPasteMarkerGuard(() => stdin.emit('readable'))
	stdin.read = function patchedRead(this: unknown, ...args: never[]): unknown {
		const chunk = originalRead.apply(this, args)
		if (chunk !== null && typeof chunk !== 'string') return chunk
		return guard.read(chunk)
	}
	let removed = false
	return () => {
		if (removed) return
		removed = true
		guard.dispose()
		stdin.read = originalRead
	}
}
