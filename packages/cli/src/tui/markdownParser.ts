import { closesFence, openingFence, stripFenceIndent } from './markdown-fence.js'

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
 * A heading is `#` to `######` on its own line. A line of dashes under a
 * paragraph (`Title` over `---`) is NOT an underlined heading: it is a
 * paragraph followed by a rule. Reading it as a heading would turn the
 * paragraph into a heading when its third dash arrived, on a reply that is
 * still streaming; a rule never changes what the line above it was.
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
	| { readonly type: 'quote'; readonly blocks: readonly MdBlock[] }
	| { readonly type: 'rule' }
	| {
			readonly type: 'code'
			readonly lang?: string
			readonly lines: readonly string[]
			/**
			 * Columns the opening fence was indented: the block is drawn at them, so a
			 * block in a list item sits under its item. Absent is none.
			 */
			readonly indent?: number
	  }
	| {
			readonly type: 'table'
			readonly headers: readonly string[]
			readonly rows: readonly string[][]
			/**
			 * Per-column alignment from the separator row (`:--`, `:-:`, `--:`).
			 * Present only when some column asks for one; absent is all left.
			 */
			readonly align?: readonly TableAlign[]
	  }

export type TableAlign = 'left' | 'center' | 'right'

export { closesFence, openingFence } from './markdown-fence.js'

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/
const BLOCKQUOTE = /^\s*>/
/** What a quote line carries before its text: the `>` and the one space after it. */
const QUOTE_MARK = /^\s*>[ \t]?/
/**
 * A rule: three or more of one of `-`, `*`, `_`, with spaces allowed between
 * and nothing else on the line. `--` is text; `- - -` is a rule, not a list.
 */
const RULE = /^\s*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/**
 * Split a `| a | b |` row into trimmed cells. A backslash-escaped pipe (`\|`)
 * is a literal `|` inside a cell, not a column boundary.
 */
function tableCells(line: string): string[] {
	let body = line.trim()
	if (body.startsWith('|')) body = body.slice(1)
	if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
	return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Alignment of each column named by a separator row, or `undefined` when all are plain. */
function tableAlign(separator: string): TableAlign[] | undefined {
	const align = tableCells(separator).map((cell): TableAlign => {
		const left = cell.startsWith(':')
		const right = cell.endsWith(':')
		return left && right ? 'center' : right ? 'right' : 'left'
	})
	return align.some((a) => a !== 'left') ? align : undefined
}

/**
 * Whether a line continues a table already begun.
 *
 * GitHub's rule, which models follow: after the header and separator, every
 * following line with a pipe in it is a row until a blank line or the start
 * of another block — a fence, a heading, a list item or a blockquote, each of
 * which ends the table even when it carries a pipe (`- a | b` is a list item).
 * The row need not close with a pipe — `a | b` is a row — and neither does a
 * row still being typed, which is the reason this is looser than
 * {@link TABLE_ROW}: `| 1 | 2` arriving mid-stream stays inside the table it
 * belongs to instead of flashing below it as a paragraph.
 */
function continuesTable(line: string): boolean {
	return (
		line.includes('|') &&
		line.trim().length > 0 &&
		openingFence(line) === null &&
		!HEADING.test(line) &&
		!BULLET.test(line) &&
		!BLOCKQUOTE.test(line)
	)
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
type BlockKind = 'code' | 'table' | 'heading' | 'rule' | 'quote' | 'bullet' | 'blank' | 'text'

function classify(line: string, next: string | undefined, terminated: boolean): BlockKind {
	if (openingFence(line) !== null) return 'code'
	// Table: a `| … |` header row immediately followed by a `|---|` separator.
	if (TABLE_ROW.test(line) && next !== undefined && TABLE_SEP.test(next)) return 'table'
	if (HEADING.test(line)) return 'heading'
	// Before a list item: `- - -` and `* * *` are rules, and would otherwise be items.
	// A rule counts once its line has ended: `***` at the end of what has arrived
	// may be the start of `***bold***`, and drawing it as a rule would flip it back.
	if (terminated && RULE.test(line)) return 'rule'
	if (BLOCKQUOTE.test(line)) return 'quote'
	if (BULLET.test(line)) return 'bullet'
	if (line.trim().length === 0) return 'blank'
	return 'text'
}

/** Where one top-level block sits in its source, and what it is. */
export interface BlockRange {
	/** Offset of the block's first character. */
	readonly start: number
	/** Offset just past its last character, newline excluded. */
	readonly end: number
	readonly kind: 'code' | 'table' | 'heading' | 'rule' | 'quote' | 'bullet' | 'text'
	/** A code block: its closing fence is present. */
	readonly closed?: boolean
}

/**
 * Where each top-level block starts and ends. `startsAs: 'text'` reads the
 * first line as prose whatever it looks like: the rest of a paragraph whose
 * earlier rows were printed already begins mid-sentence, and `2. Then` there
 * is not a list item.
 */
export function scanBlockRanges(src: string, startsAs?: 'text'): BlockRange[] {
	const lines = src.split('\n')
	const starts: number[] = []
	let at = 0
	for (const line of lines) {
		starts.push(at)
		at += line.length + 1
	}
	const endOf = (i: number): number => (starts[i] ?? 0) + (lines[i] ?? '').length
	const ranges: BlockRange[] = []
	let forced = startsAs === 'text'
	let i = 0
	while (i < lines.length) {
		const line = lines[i] ?? ''
		const kind = classify(line, lines[i + 1], i < lines.length - 1)
		if (kind === 'blank') {
			i++
			continue
		}
		if (forced) {
			forced = false
			let end = i
			while (
				end < lines.length &&
				(end === i || classify(lines[end] ?? '', lines[end + 1], end < lines.length - 1) === 'text')
			)
				end++
			ranges.push({ start: starts[i] ?? 0, end: endOf(end - 1), kind: 'text' })
			i = end
			continue
		}
		switch (kind) {
			case 'code': {
				// Run to the closing fence, or to the end of the text — a reply
				// still streaming in has an open fence for as long as it is inside
				// one, and that is a code block with what has arrived so far.
				const opener = openingFence(line)
				let end = i + 1
				while (end < lines.length && !(opener && closesFence(lines[end] ?? '', opener))) end++
				const last = Math.min(end, lines.length - 1)
				ranges.push({
					start: starts[i] ?? 0,
					end: endOf(last),
					kind: 'code',
					closed: end < lines.length,
				})
				i = end + 1
				break
			}
			case 'table': {
				let end = i + 2 // header + separator
				while (end < lines.length && continuesTable(lines[end] ?? '')) end++
				ranges.push({ start: starts[i] ?? 0, end: endOf(end - 1), kind: 'table' })
				i = end
				break
			}
			case 'quote': {
				// Every following line that carries a `>` is the same quote. A line
				// without one ends it: there is no lazy continuation to guess at while
				// a reply is still arriving.
				let end = i
				while (end < lines.length && BLOCKQUOTE.test(lines[end] ?? '')) end++
				ranges.push({ start: starts[i] ?? 0, end: endOf(end - 1), kind: 'quote' })
				i = end
				break
			}
			case 'rule':
			case 'heading':
			case 'bullet':
				ranges.push({ start: starts[i] ?? 0, end: endOf(i), kind })
				i++
				break
			default: {
				// A paragraph is every following line that begins nothing else.
				let end = i
				while (
					end < lines.length &&
					classify(lines[end] ?? '', lines[end + 1], end < lines.length - 1) === 'text'
				)
					end++
				ranges.push({ start: starts[i] ?? 0, end: endOf(end - 1), kind: 'text' })
				i = end
				break
			}
		}
	}
	return ranges
}

/**
 * Split markdown source into the raw text of each top-level block, in order.
 *
 * Blank lines separate blocks and belong to none, so they appear in no segment.
 * Every other line lands in exactly one, which is what lets a segment be used
 * as a cache key: two turns that produce the same segment produce the same
 * block, because {@link parseBlock} reads nothing else.
 */
export function scanBlocks(src: string, startsAs?: 'text'): string[] {
	// The trailing newline in a rule's segment is what tells parseBlock the
	// line was ended, so a rule and the same characters still arriving are
	// different segments.
	return scanBlockRanges(src, startsAs).map((r) =>
		r.kind === 'rule' ? `${src.slice(r.start, r.end)}\n` : src.slice(r.start, r.end),
	)
}

/** Parse one block's raw text — a segment from {@link scanBlocks} — into a block. */
export function parseBlock(raw: string, as?: 'text'): MdBlock {
	const lines = raw.split('\n')
	const first = lines[0] ?? ''
	switch (as === 'text' ? 'text' : classify(first, lines[1], lines.length > 1)) {
		case 'code': {
			const opener = openingFence(first)
			// The closing fence is part of the segment when the block is closed and
			// absent while it is still arriving, so it is dropped only if present.
			// A segment that is nothing but its opening fence has no body to drop a
			// line from.
			const closed =
				opener !== null && lines.length > 1 && closesFence(lines[lines.length - 1] ?? '', opener)
			const indent = opener?.indent ?? 0
			return {
				type: 'code',
				...(opener?.lang ? { lang: opener.lang } : {}),
				...(indent > 0 ? { indent } : {}),
				lines: (closed ? lines.slice(1, -1) : lines.slice(1)).map((l) =>
					stripFenceIndent(l, indent),
				),
			}
		}
		case 'table': {
			const align = tableAlign(lines[1] ?? '')
			return {
				type: 'table',
				headers: tableCells(first),
				rows: lines.slice(2).map(tableCells),
				...(align ? { align } : {}),
			}
		}
		case 'heading': {
			const heading = HEADING.exec(first)
			return { type: 'heading', level: heading?.[1]?.length ?? 1, text: heading?.[2] ?? '' }
		}
		case 'rule':
			return { type: 'rule' }
		case 'quote':
			// One level of `>` comes off every line and what is left is markdown of
			// its own: paragraphs, lists, another quote. Still a function of the
			// segment alone.
			return {
				type: 'quote',
				blocks: parseMarkdown(lines.map((l) => l.replace(QUOTE_MARK, '')).join('\n')),
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
	return scanBlocks(src).map((segment) => parseBlock(segment))
}

// Underscores inside identifiers are literal, including non-ASCII names.
const INLINE =
	/(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|((?<![\p{L}\p{N}\p{M}_])__[^_]+__(?![\p{L}\p{N}\p{M}_]))|(\*[^*]+\*)|((?<![\p{L}\p{N}\p{M}_])_[^_]+_(?![\p{L}\p{N}\p{M}_]))/u
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/

/**
 * Where each inline marker that has not closed begins.
 *
 * A marker left over after every complete span is read is one a later
 * character can still pair with, and pairing it changes how the text before
 * it is drawn. Text that holds one is not final.
 */
export function openMarkersIn(text: string): number[] {
	const found: number[] = []
	let base = 0
	let rest = text
	while (rest.length > 0) {
		const match = INLINE.exec(rest)
		const plain = match ? rest.slice(0, match.index) : rest
		for (let k = 0; k < plain.length; k++) {
			const ch = plain[k]
			if (ch === '`' || ch === '[' || ch === '*') found.push(base + k)
			else if (ch === '_' && !/[\p{L}\p{N}\p{M}_]/u.test(text[base + k - 1] ?? ''))
				found.push(base + k)
		}
		if (!match) break
		base += match.index + match[0].length
		rest = rest.slice(match.index + match[0].length)
	}
	return found
}

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
			// Emphasis may hold other spans — `**\`pkg\`**` is bold code — so
			// its inside is parsed too and every piece carries the emphasis.
			spans.push(...parseInline(token.slice(2, -2)).map((span) => ({ ...span, bold: true })))
		} else {
			spans.push(...parseInline(token.slice(1, -1)).map((span) => ({ ...span, italic: true })))
		}
		rest = rest.slice(match.index + token.length)
	}
	return spans.length > 0 ? spans : [{ text: '' }]
}

/** The line shapes the streaming view reads: the same expressions the parser classifies with. */
export const LINE_SHAPES = {
	fence: openingFence,
	heading: HEADING,
	bullet: BULLET,
	quoteMark: QUOTE_MARK,
	tableSep: TABLE_SEP,
	tableRow: TABLE_ROW,
} as const
