import stringWidth from 'string-width'

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

/** Cells between tab stops in a terminal. */
const TAB_STOP = 8

/**
 * Replace each tab with the spaces the terminal would advance over, line by
 * line. The renderer measures a tab as no width while the terminal moves to the
 * next stop, so a clipped region cuts a tab-bearing line short; spaces measure
 * the same everywhere. A view operation, like {@link terminalDisplayText}.
 */
export function expandTabs(source: string): string {
	if (!source.includes('\t')) return source
	return source
		.split('\n')
		.map((line) => {
			if (!line.includes('\t')) return line
			let out = ''
			let column = 0
			for (const char of line) {
				if (char === '\t') {
					const pad = TAB_STOP - (column % TAB_STOP)
					out += ' '.repeat(pad)
					column += pad
				} else {
					out += char
					column += stringWidth(char)
				}
			}
			return out
		})
		.join('\n')
}

export interface ScriptTextOptions {
	/** What stands in for a line break; a space by default. */
	readonly newline?: string
	/** What stands in for a tab; a space by default. */
	readonly tab?: string
	/** Cut to this many terminal cells and end with an ellipsis. Nothing is cut when absent. */
	readonly maxCells?: number
}

/**
 * Text a workflow script supplies (a name, a phase title, an agent label, a
 * log line) as one safe row. The script builds these at run time from file
 * names and from what agents answered, so they are untrusted: control
 * characters, direction overrides and zero-width characters come out spelled
 * as `\u{....}` literals (see {@link terminalDisplayText}), and line breaks
 * and tabs become one-row stand-ins. This is the one place that rule lives;
 * every row that draws such text goes through it. A view operation: the
 * journal and the run record keep the source text.
 */
export function scriptText(source: string, options: ScriptTextOptions = {}): string {
	const flat = terminalDisplayText(source)
		.replace(/\r?\n/g, options.newline ?? ' ')
		.replace(/\t/g, options.tab ?? ' ')
	const max = options.maxCells
	if (max === undefined || stringWidth(flat) <= max) return flat
	let out = ''
	let cells = 0
	for (const char of flat) {
		const width = stringWidth(char)
		if (cells + width > max - 1) break
		out += char
		cells += width
	}
	return `${out.trimEnd()}…`
}
