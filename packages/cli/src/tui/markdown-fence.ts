/**
 * The one grammar of a fenced code block, shared by everything that reads a
 * reply: the parser, the streaming view, the fullscreen rows and `/copy`.
 *
 * - An opening fence is three or more backticks or three or more tildes,
 *   indented, followed by an optional info string. The info string of a
 *   backtick fence holds no backtick (otherwise the line is inline code).
 * - The language is the first word of the info string; the rest (a title, a
 *   file name, attributes) is not read.
 * - The block closes at a fence of the same character, at least as long as the
 *   opener, with nothing after it, or at the end of the text.
 * - Content lines lose the opener's indentation and nothing else.
 *
 * Indentation: a fence is indented to the column of its container (the content
 * column of a list item, the text after a `>`). The block model has no
 * container to measure from, so any indentation opens a fence, and a closing
 * fence may sit up to three columns deeper than the opener. A fence indented
 * four columns or more outside a list is a fence here, where CommonMark would
 * read an indented code block; a reply written by a model does not use the
 * second form to hold a fence.
 *
 * Pure and dependency-free: `parseBlock` must stay a function of its segment.
 */

export interface FenceOpener {
	readonly char: '`' | '~'
	/** How many fence characters opened the block. */
	readonly length: number
	/** The opener's indentation in columns (a tab counts four). */
	readonly indent: number
	/** The first word of the info string, when there is one. */
	readonly lang?: string
}

const OPEN = /^([ \t]*)(`{3,}|~{3,})(.*?)\s*$/u
const CLOSE = /^([ \t]*)(`+|~+)\s*$/u
const TAB = 4

/** Columns taken by leading whitespace. */
export function indentColumns(space: string): number {
	let n = 0
	for (const ch of space) n += ch === '\t' ? TAB : 1
	return n
}

/** The opening fence a line is, or null when the line is not one. */
export function openingFence(line: string): FenceOpener | null {
	const m = OPEN.exec(line)
	if (!m) return null
	const fence = m[2] as string
	const info = (m[3] as string).trim()
	if (fence[0] === '`' && info.includes('`')) return null
	const lang = info.split(/[\s,]/u, 1)[0]
	return {
		char: fence[0] as '`' | '~',
		length: fence.length,
		indent: indentColumns(m[1] as string),
		...(lang ? { lang } : {}),
	}
}

/** Whether `line` closes a block `opener` opened. */
export function closesFence(line: string, opener: FenceOpener): boolean {
	const m = CLOSE.exec(line)
	if (!m) return false
	const run = m[2] as string
	return (
		run[0] === opener.char &&
		run.length >= opener.length &&
		indentColumns(m[1] as string) <= opener.indent + 3
	)
}

/** A content line with the opener's indentation taken off, and nothing else. */
export function stripFenceIndent(line: string, indent: number): string {
	let cols = 0
	let at = 0
	while (at < line.length && cols < indent) {
		const ch = line[at]
		if (ch === ' ') cols += 1
		else if (ch === '\t') cols += TAB
		else break
		at += 1
	}
	return line.slice(at)
}

/**
 * The opener as one line of its own, for a block continued after a part of it
 * was printed: the rest of the block reads as the block it was, with the same
 * fence character and length and the same indentation.
 */
export function openerLine(opener: FenceOpener): string {
	return `${' '.repeat(opener.indent)}${opener.char.repeat(opener.length)}${opener.lang ?? ''}`
}
