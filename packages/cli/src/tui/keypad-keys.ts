/**
 * Make every keypad key act as the key it stands for.
 *
 * The message box asks the terminal for the kitty keyboard protocol (`disambiguateEscapeCodes`).
 * Under it a terminal reports each keypad key as a code of its own (`ESC [ 57414 u` for the
 * keypad Enter) instead of the byte the main key sends. Ink names those codes `kpenter`, `kp0`
 * and so on and sets `key.return` only for a real Enter, so the keypad Enter never sent a
 * message and the keypad digits were not typed.
 *
 * This reads the stream before Ink does, like `focus-reporting.ts` and `paste-marker-guard.ts`,
 * and rewrites each keypad sequence into what the main key sends: the plain byte or legacy
 * sequence when no modifier is held, and the main key's own kitty form (with the same modifier
 * and event field) when one is. Every component then receives the keys it already handles,
 * with nothing changed in any of them. The keypad's "begin" key (the middle of the keypad with
 * Num Lock off) has no main-keyboard twin and is dropped.
 */

const ESC = '\u001b'

/** The first and last keypad code the protocol defines (`KP_0` and `KP_BEGIN`). */
const FIRST_KEYPAD_CODE = 57399
const LAST_KEYPAD_CODE = 57427

/** Caps Lock and Num Lock bits of the protocol's modifier field. They change no key. */
const LOCK_BITS = 64 | 128

type Target =
	| { readonly kind: 'char'; readonly code: number; readonly plain: string }
	| { readonly kind: 'letter'; readonly letter: string }
	| { readonly kind: 'tilde'; readonly number: number }
	| { readonly kind: 'none' }

const char = (code: number, plain = String.fromCharCode(code)): Target => ({
	kind: 'char',
	code,
	plain,
})

const TARGETS: Readonly<Record<number, Target>> = {
	57399: char(48),
	57400: char(49),
	57401: char(50),
	57402: char(51),
	57403: char(52),
	57404: char(53),
	57405: char(54),
	57406: char(55),
	57407: char(56),
	57408: char(57),
	57409: char(46),
	57410: char(47),
	57411: char(42),
	57412: char(45),
	57413: char(43),
	57414: char(13, '\r'),
	57415: char(61),
	57416: char(44),
	57417: { kind: 'letter', letter: 'D' },
	57418: { kind: 'letter', letter: 'C' },
	57419: { kind: 'letter', letter: 'A' },
	57420: { kind: 'letter', letter: 'B' },
	57421: { kind: 'tilde', number: 5 },
	57422: { kind: 'tilde', number: 6 },
	57423: { kind: 'letter', letter: 'H' },
	57424: { kind: 'letter', letter: 'F' },
	57425: { kind: 'tilde', number: 2 },
	57426: { kind: 'tilde', number: 3 },
	57427: { kind: 'none' },
}

const KEYPAD_SEQUENCE = new RegExp(`${ESC}\\[(\\d+)(?:;(\\d*)(?::(\\d+))?(?:;[\\d:]*)?)?u`, 'g')

function rewrite(code: number, modifiers: number, eventType: number | undefined): string | null {
	const target = TARGETS[code]
	if (target === undefined) return null
	if (target.kind === 'none') return ''
	const held = (modifiers - 1) & ~LOCK_BITS
	const tail =
		eventType === undefined || eventType === 1
			? held === 0
				? ''
				: `;${String(modifiers)}`
			: `;${String(modifiers)}:${String(eventType)}`
	switch (target.kind) {
		case 'char':
			return tail === '' ? target.plain : `${ESC}[${String(target.code)}${tail}u`
		case 'letter':
			return `${ESC}[${tail === '' ? '' : '1'}${tail}${target.letter}`
		case 'tilde':
			return `${ESC}[${String(target.number)}${tail}~`
	}
}

/** Rewrite every keypad sequence in `chunk`; anything else stays byte-identical. */
export function normalizeKeypadKeys(chunk: string): string {
	if (!chunk.includes(`${ESC}[57`)) return chunk
	return chunk.replace(
		KEYPAD_SEQUENCE,
		(whole: string, codeText: string, modText?: string, eventText?: string) => {
			const code = Number.parseInt(codeText, 10)
			if (code < FIRST_KEYPAD_CODE || code > LAST_KEYPAD_CODE) return whole
			const modifiers = modText === undefined || modText === '' ? 1 : Number.parseInt(modText, 10)
			const eventType = eventText === undefined ? undefined : Number.parseInt(eventText, 10)
			return rewrite(code, modifiers, eventType) ?? whole
		},
	)
}

interface KeypadInput {
	read: (...args: never[]) => unknown
}

/** Wrap `stdin.read` so the reader sees keypad keys as main-keyboard keys. Returns the undo. */
export function installKeypadKeys(stdin: KeypadInput): () => void {
	const originalRead = stdin.read
	stdin.read = function patchedRead(this: unknown, ...args: never[]): unknown {
		const chunk = originalRead.apply(this, args)
		return typeof chunk === 'string' ? normalizeKeypadKeys(chunk) : chunk
	}
	let removed = false
	return () => {
		if (removed) return
		removed = true
		stdin.read = originalRead
	}
}
