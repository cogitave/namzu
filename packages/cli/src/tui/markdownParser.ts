/**
 * Lightweight, dependency-free markdown parsing for the transcript. Splits
 * text into block elements (paragraphs, headings, bullet/ordered list
 * items, fenced code blocks) and parses inline spans (bold, italic, inline
 * code) within them. Pure — unit-tested. The renderer lives in Markdown.tsx.
 *
 * This is deliberately a small subset (what assistant replies actually
 * use), not a full CommonMark implementation. Syntax highlighting inside
 * code blocks is intentionally out of scope; code is shown in one code
 * color, which reads cleanly without a highlighter dependency.
 *
 * ## Two halves, because a streaming reply is re-parsed on every token
 *
 * {@link parseMarkdown} is {@link scanBlocks} followed by {@link parseBlock}
 * per segment, and the split is what makes the per-block cache in
 * `markdown-block-cache.ts` possible: scanning finds where each top-level
 * block starts and ends, and parsing turns one block's raw text into one
 * {@link MdBlock}. The cache can then skip the second half for text it has
 * already seen.
 *
 * **{@link parseBlock} is a pure function of the segment handed to it** —
 * nothing about a block's meaning depends on another block. That is what makes
 * a cache keyed on raw text sound rather than merely convenient, and it is a
 * property to preserve: reference-style link definitions (`[a]: http://…`),
 * for instance, would make one block's rendering depend on another's presence
 * and would have to be either implemented across the whole document or not at
 * all. This subset has no such construct, and nothing here should acquire one
 * without revisiting the cache.
 *
 * There is one classifier, {@link classify}. The scanner uses it to find
 * boundaries and {@link parseBlock} uses it to dispatch, so "what is this
 * line" is decided in a single place rather than once per half.
 */

export interface InlineSpan {
	readonly text: string
	readonly bold?: boolean
	readonly italic?: boolean
	readonly code?: boolean
	/** Present for `[text](url)` links — the destination URL. */
	readonly link?: string
}

export type MdBlock =
	| { readonly type: 'paragraph'; readonly text: string }
	| { readonly type: 'heading'; readonly level: number; readonly text: string }
	| {
			readonly type: 'bullet'
			readonly ordered: boolean
			readonly marker: string
			readonly text: string
	  }
	| { readonly type: 'code'; readonly lang?: string; readonly lines: readonly string[] }
	| {
			readonly type: 'table'
			readonly headers: readonly string[]
			readonly rows: readonly string[][]
	  }

const FENCE = /^```(\w*)\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/** Split a `| a | b |` row into trimmed cells. */
function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim())
}

/**
 * What a line begins, given the line after it.
 *
 * The single site for "which construct is this". `'blank'` begins nothing and
 * `'text'` begins (or continues) a paragraph; the rest name themselves. The
 * order of the tests is the order the old single-pass parser applied them, and
 * it is load-bearing: a `| … |` line is a table only when a separator follows,
 * and falls through to a paragraph otherwise.
 */
type BlockKind = 'code' | 'table' | 'heading' | 'bullet' | 'blank' | 'text'

function classify(line: string, next: string | undefined): BlockKind {
	if (FENCE.test(line)) return 'code'
	// Table: a `| … |` header row immediately followed by a `|---|` separator.
	if (TABLE_ROW.test(line) && next !== undefined && TABLE_SEP.test(next)) return 'table'
	if (HEADING.test(line)) return 'heading'
	if (BULLET.test(line)) return 'bullet'
	if (line.trim().length === 0) return 'blank'
	return 'text'
}

/**
 * Split markdown source into the raw text of each top-level block, in order.
 *
 * Blank lines separate blocks and belong to none, so they appear in no segment.
 * Every other line lands in exactly one, which is what lets a segment be used
 * as a cache key: two runs that produce the same segment produce the same
 * block, because {@link parseBlock} reads nothing else.
 */
export function scanBlocks(src: string): string[] {
	const lines = src.split('\n')
	const segments: string[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i] ?? ''
		switch (classify(line, lines[i + 1])) {
			case 'blank':
				i++
				break
			case 'code': {
				// Run to the closing fence, or to the end of the text — a reply
				// still streaming in has an open fence for as long as it is inside
				// one, and that is a code block with what has arrived so far.
				let end = i + 1
				while (end < lines.length && !FENCE.test(lines[end] ?? '')) end++
				const last = Math.min(end, lines.length - 1)
				segments.push(lines.slice(i, last + 1).join('\n'))
				i = end + 1
				break
			}
			case 'table': {
				let end = i + 2 // header + separator
				while (end < lines.length && TABLE_ROW.test(lines[end] ?? '')) end++
				segments.push(lines.slice(i, end).join('\n'))
				i = end
				break
			}
			case 'heading':
			case 'bullet':
				segments.push(line)
				i++
				break
			default: {
				// A paragraph is every following line that begins nothing else.
				let end = i
				while (end < lines.length && classify(lines[end] ?? '', lines[end + 1]) === 'text') end++
				segments.push(lines.slice(i, end).join('\n'))
				i = end
				break
			}
		}
	}
	return segments
}

/** Parse one block's raw text — a segment from {@link scanBlocks} — into a block. */
export function parseBlock(raw: string): MdBlock {
	const lines = raw.split('\n')
	const first = lines[0] ?? ''
	switch (classify(first, lines[1])) {
		case 'code': {
			const lang = FENCE.exec(first)?.[1]
			// The closing fence is part of the segment when the block is closed and
			// absent while it is still arriving, so it is dropped only if present.
			// A segment that is nothing but its opening fence reads as closed and
			// is right either way: there is no body to drop a line from.
			const closed = FENCE.test(lines[lines.length - 1] ?? '')
			return {
				type: 'code',
				...(lang ? { lang } : {}),
				lines: closed ? lines.slice(1, -1) : lines.slice(1),
			}
		}
		case 'table':
			return {
				type: 'table',
				headers: tableCells(first),
				rows: lines.slice(2).map(tableCells),
			}
		case 'heading': {
			const heading = HEADING.exec(first)
			return { type: 'heading', level: heading?.[1]?.length ?? 1, text: heading?.[2] ?? '' }
		}
		case 'bullet': {
			const bullet = BULLET.exec(first)
			const rawMarker = bullet?.[2] ?? '-'
			const ordered = /\d/.test(rawMarker)
			return {
				type: 'bullet',
				ordered,
				marker: ordered ? rawMarker.replace(/[.)]$/, '') : '•',
				text: bullet?.[3] ?? '',
			}
		}
		default:
			return { type: 'paragraph', text: lines.map((l) => l.trim()).join(' ') }
	}
}

/** Parse markdown source into a flat list of block elements. */
export function parseMarkdown(src: string): MdBlock[] {
	return scanBlocks(src).map(parseBlock)
}

const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/

/** Parse a single line of text into styled inline spans. */
export function parseInline(text: string): InlineSpan[] {
	const spans: InlineSpan[] = []
	let rest = text
	while (rest.length > 0) {
		const match = INLINE.exec(rest)
		if (!match || match.index === undefined) {
			spans.push({ text: rest })
			break
		}
		if (match.index > 0) {
			spans.push({ text: rest.slice(0, match.index) })
		}
		const token = match[0]
		const linkMatch = LINK.exec(token)
		if (token.startsWith('`')) {
			spans.push({ text: token.slice(1, -1), code: true })
		} else if (linkMatch) {
			spans.push({ text: linkMatch[1] ?? '', link: linkMatch[2] ?? '' })
		} else if (token.startsWith('**') || token.startsWith('__')) {
			spans.push({ text: token.slice(2, -2), bold: true })
		} else {
			spans.push({ text: token.slice(1, -1), italic: true })
		}
		rest = rest.slice(match.index + token.length)
	}
	return spans.length > 0 ? spans : [{ text: '' }]
}
