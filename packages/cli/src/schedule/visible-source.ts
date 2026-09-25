/**
 * Text-mode schedule views write directly to a terminal. Keep the source
 * readable, but show controls and invisible formatting characters as code
 * points so a script cannot clear or reorder its own confirmation screen.
 *
 * The escape form is unambiguous: when it is needed, literal backslashes are
 * doubled as well. A source spelling of `\u{001b}` therefore looks different
 * from an actual ESC byte. Newlines remain newlines so multi-line scripts can
 * still be reviewed line by line. Stored jobs and JSON output stay untouched.
 */

export const VISIBLE_SOURCE_NOTE =
	'Hidden/control characters below are shown as \\u{CODEPOINT}; literal backslashes are doubled. The stored source runs, not this display form.'

/** A literal source escape that would otherwise look like a projected code point. */
const LOOKS_LIKE_ESCAPE = /\\u\{[0-9a-fA-F]{4,6}\}/

function hidden(code: number): boolean {
	if (code <= 0x1f) return code !== 0x0a
	return (
		(code >= 0x7f && code <= 0x9f) ||
		code === 0xad ||
		code === 0x61c ||
		code === 0x180e ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x206f) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xfeff ||
		(code >= 0xfff9 && code <= 0xfffb) ||
		(code >= 0xe0000 && code <= 0xe007f) ||
		(code >= 0xe0100 && code <= 0xe01ef)
	)
}

export function visibleScheduleSource(source: string): {
	readonly text: string
	readonly escaped: boolean
} {
	let escaped = LOOKS_LIKE_ESCAPE.test(source)
	if (!escaped) {
		for (const char of source) {
			if (hidden(char.codePointAt(0) ?? 0)) {
				escaped = true
				break
			}
		}
	}
	if (!escaped) return { text: source, escaped: false }

	let text = ''
	for (const char of source) {
		const code = char.codePointAt(0) ?? 0
		if (char === '\\') text += '\\\\'
		else if (hidden(code)) text += `\\u{${code.toString(16).padStart(4, '0')}}`
		else text += char
	}
	return { text, escaped: true }
}

/** For a human-facing message only. Keep the original string in storage/JSON. */
export function visibleScheduleMessage(source: string): string {
	const view = visibleScheduleSource(source)
	return view.escaped ? `${VISIBLE_SOURCE_NOTE}\n${view.text}` : view.text
}
