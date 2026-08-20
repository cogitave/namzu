/**
 * Project untrusted text into a terminal-safe, source-preserving display form.
 *
 * This is deliberately a view operation. Conversation history, tool requests,
 * exports and clipboard copies keep the exact source bytes; only strings handed
 * to Ink pass through here. Newlines and tabs remain useful layout characters,
 * and CRLF is normalized to one newline. Every other C0/C1 control plus the
 * invisible directional characters that can reorder a consent prompt becomes
 * an explicit ASCII `\\u{....}` literal.
 */
export function terminalDisplayText(source: string): string {
	let projected: string | undefined
	let index = 0

	while (index < source.length) {
		const codePoint = source.codePointAt(index)
		if (codePoint === undefined) break
		const width = codePoint > 0xffff ? 2 : 1

		// A provider or command commonly emits CRLF. Keeping the carriage return
		// would hand cursor movement to the text; showing an escape on every line
		// would turn ordinary output into noise. One safe newline is the exact
		// display meaning of the pair.
		if (codePoint === 0x0d && source.charCodeAt(index + 1) === 0x0a) {
			projected ??= source.slice(0, index)
			projected += '\n'
			index += 2
			continue
		}

		if (isUnsafeTerminalCodePoint(codePoint)) {
			projected ??= source.slice(0, index)
			projected += visibleCodePoint(codePoint)
		} else if (projected !== undefined) {
			projected += String.fromCodePoint(codePoint)
		}
		index += width
	}

	return projected ?? source
}

function visibleCodePoint(codePoint: number): string {
	return `\\u{${codePoint.toString(16).padStart(4, '0')}}`
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
	// LF and TAB are the two useful terminal layout controls. CR is safe only as
	// the CRLF pair normalized by the caller above; a lone one rewinds the row.
	if (codePoint <= 0x1f) return codePoint !== 0x0a && codePoint !== 0x09
	if (codePoint >= 0x7f && codePoint <= 0x9f) return true

	// Unicode line/paragraph separators create lines without an ASCII newline.
	if (codePoint === 0x2028 || codePoint === 0x2029) return true

	// Directional and invisible formatting controls that can make the painted
	// order disagree with the source. ZWNJ/ZWJ stay available for scripts that
	// legitimately require them; variation selectors stay available to emoji.
	return (
		codePoint === 0x061c ||
		codePoint === 0x200b ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2060 && codePoint <= 0x2064) ||
		(codePoint >= 0x2066 && codePoint <= 0x206f) ||
		codePoint === 0xfeff
	)
}
