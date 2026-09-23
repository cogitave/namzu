/**
 * Text that crosses into another program — a desktop notification, a history
 * summary — is data, and is made safe to show as data.
 *
 * Control characters (C0, DEL, C1), format characters that render as nothing
 * (zero-width space and joiners, soft hyphen, the byte-order mark) and the
 * bidirectional controls (embeddings, overrides, isolates, marks) are removed;
 * whitespace runs become one space; the result is capped with an ellipsis.
 * Written over code points rather than a regular expression so the ranges are
 * plain numbers a reader can check.
 */

const STRIPPED: readonly (readonly [number, number])[] = [
	[0x0000, 0x001f], // C0 controls (newline and tab too: a notification is one line)
	[0x007f, 0x009f], // DEL and C1 controls
	[0x00ad, 0x00ad], // soft hyphen
	[0x061c, 0x061c], // Arabic letter mark
	[0x180e, 0x180e], // Mongolian vowel separator
	[0x200b, 0x200f], // zero-width space, joiners, LRM, RLM
	[0x2028, 0x202e], // line and paragraph separators, embeddings and overrides
	[0x2060, 0x206f], // word joiner, invisible operators, isolates, deprecated formats
	[0xfeff, 0xfeff], // byte-order mark
	[0xfff9, 0xfffb], // interlinear annotations
]

function stripped(code: number): boolean {
	return STRIPPED.some(([lo, hi]) => code >= lo && code <= hi)
}

/** One safe line of at most `max` characters. */
export function sanitizeLine(text: string, max: number): string {
	let out = ''
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0
		if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' '
		else if (!stripped(code)) out += ch
	}
	out = out.replace(/\s+/g, ' ').trim()
	const chars = [...out]
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : out
}

/** The first non-empty line of `text`, made safe and capped: a run's summary. */
export function summaryOf(text: string, max = 200): string {
	const first = text
		.split(/\r?\n/)
		.map((line) => line.replace(/^[#>*\-\s`]+/, '').trim())
		.find((line) => line.length > 0)
	return first ? sanitizeLine(first, max) : ''
}
