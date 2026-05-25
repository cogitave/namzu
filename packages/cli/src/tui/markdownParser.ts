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

/** Parse markdown source into a flat list of block elements. */
export function parseMarkdown(src: string): MdBlock[] {
	const lines = src.split('\n')
	const blocks: MdBlock[] = []
	let para: string[] = []

	const flushPara = () => {
		if (para.length > 0) {
			blocks.push({ type: 'paragraph', text: para.join(' ') })
			para = []
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		const fence = FENCE.exec(line)
		if (fence) {
			flushPara()
			const lang = fence[1] ? fence[1] : undefined
			const codeLines: string[] = []
			i++
			while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
				codeLines.push(lines[i] ?? '')
				i++
			}
			// `i` now points at the closing fence (or end); the for-loop ++ skips it.
			blocks.push({ type: 'code', lang, lines: codeLines })
			continue
		}
		// Table: a `| … |` header row immediately followed by a `|---|` separator.
		if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1] ?? '')) {
			flushPara()
			const headers = tableCells(line)
			i += 2 // skip header + separator
			const rows: string[][] = []
			while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
				rows.push(tableCells(lines[i] ?? ''))
				i++
			}
			i-- // for-loop ++ will re-advance past the last consumed row
			blocks.push({ type: 'table', headers, rows })
			continue
		}
		const heading = HEADING.exec(line)
		if (heading) {
			flushPara()
			blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
			continue
		}
		const bullet = BULLET.exec(line)
		if (bullet) {
			flushPara()
			const rawMarker = bullet[2] ?? '-'
			const ordered = /\d/.test(rawMarker)
			blocks.push({
				type: 'bullet',
				ordered,
				marker: ordered ? rawMarker.replace(/[.)]$/, '') : '•',
				text: bullet[3] ?? '',
			})
			continue
		}
		if (line.trim().length === 0) {
			flushPara()
			continue
		}
		para.push(line.trim())
	}
	flushPara()
	return blocks
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
