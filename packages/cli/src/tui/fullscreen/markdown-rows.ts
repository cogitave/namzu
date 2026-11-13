/**
 * A reply's Markdown as rows, for the fullscreen window.
 *
 * The window is a list of rows, so the Markdown is laid out to rows here; it
 * does not draw anything the normal transcript does not. Every choice is the
 * one `Markdown.tsx` makes, from the same parser, the same wrapper and the same
 * table layout: what each block looks like, the blank row between blocks, how a
 * bullet hangs, and how a code line too long for a row is cut (`code-wrap.ts`). The tests draw
 * both and compare the screens, so the two cannot drift apart unseen.
 */

import {
	type CodeLine,
	colourLines,
	grammarState,
	grammarVersion,
	runsForPieces,
} from '../code-highlight.js'
import {
	QUOTE_BAR,
	QUOTE_BAR_WIDTH,
	blockGap,
	codeChars,
	codeIndent,
	headingStyle,
	ruleWidth,
} from '../markdown-structure.js'
import { layoutTable } from '../markdown-table.js'
import type { TableSpan } from '../markdown-table.js'
import { type DisplaySpan, inlineDisplaySpans, wrapSpans } from '../markdown-wrap.js'
import { type MdBlock, parseMarkdown } from '../markdownParser.js'
import { terminalDisplayText } from '../terminal-display.js'
import { shownTheme } from '../theme-store.js'
import { theme } from '../theme.js'
import { wrapCodeLine } from './code-wrap.js'
import { wrapJoiners } from './joiners.js'
import { type Joiner, type StyledSpan, spansText } from './rows.js'

/** One row of rendered Markdown, before a glyph is put beside it. */
export interface MarkdownRow {
	readonly spans: readonly StyledSpan[]
	readonly text: string
	readonly joins: Joiner | null
	readonly lead: number
}

function row(spans: readonly StyledSpan[], joins: Joiner | null = null, lead = 0): MarkdownRow {
	return { spans, text: spansText(spans), joins, lead }
}

/** One span as `Markdown.tsx`'s `SpanView` draws it. */
function styled(span: DisplaySpan & Pick<TableSpan, 'border'>, color: string): StyledSpan {
	if (span.border) return { text: span.text, color: theme.border.default }
	if (span.muted) return { text: span.text, color: theme.text.muted }
	if (span.code) {
		return {
			text: span.text,
			color: theme.status.ok,
			...(span.bold ? { bold: true } : {}),
			...(span.italic ? { italic: true } : {}),
		}
	}
	if (span.link) {
		return {
			text: span.text,
			color: theme.accent.user,
			underline: true,
			...(span.bold ? { bold: true } : {}),
		}
	}
	return {
		text: span.text,
		color,
		...(span.bold ? { bold: true } : {}),
		...(span.italic ? { italic: true } : {}),
	}
}

/** Inline Markdown wrapped to `width` cells, as rows of spans. */
function wrappedRows(
	source: string,
	width: number,
	color: string,
	paint: (span: StyledSpan) => StyledSpan,
): { lines: StyledSpan[][]; joins: (Joiner | null)[] } {
	const spans = inlineDisplaySpans(source, false)
	const lines = wrapSpans(spans, width).map((line) =>
		line.map((span) => paint(styled(span, color))),
	)
	const joins = wrapJoiners(
		spans.map((span) => span.text).join(''),
		lines.map((line) => spansText(line)),
	)
	return { lines, joins }
}

function blockRows(
	block: MdBlock,
	width: number,
	color: string,
	italic: boolean,
	spent: number,
): MarkdownRow[] {
	// The text of a quote is italic: the outer `<Text italic>` of the normal
	// transcript reaches every span of a paragraph, a bullet and a heading.
	const prose = (s: StyledSpan): StyledSpan => (italic ? { ...s, italic: true } : s)
	switch (block.type) {
		case 'heading': {
			// As `Markdown.tsx`: bold on every span, underlined for level 1, and the
			// spans take the level's colour.
			const style = headingStyle(block.level)
			const headingColor =
				style.color === 'accent'
					? theme.accent.user
					: style.color === 'muted'
						? theme.text.muted
						: color
			const { lines, joins } = wrappedRows(block.text, width, headingColor, (s) =>
				prose({ ...s, bold: true, ...(style.underline ? { underline: true } : {}) }),
			)
			return lines.map((line, i) => row(line, joins[i] ?? null))
		}
		case 'rule':
			return [row([{ text: '─'.repeat(ruleWidth(width)), color: theme.border.default }])]
		case 'quote': {
			const inner =
				block.blocks.length > 0
					? blocksRows(block.blocks, width - QUOTE_BAR_WIDTH, color, true, spent)
					: [row([])]
			// The bar and its space go before every row, so a wrapped row carries it too.
			// A copy that joins a wrapped row to the one above starts after them.
			return inner.map((r) =>
				row(
					[{ text: QUOTE_BAR, color: theme.border.default }, { text: ' ' }, ...r.spans],
					r.joins,
					r.lead + QUOTE_BAR_WIDTH,
				),
			)
		}
		case 'bullet': {
			const marker = block.ordered ? `${block.marker}.` : block.marker
			const lead = marker.length + 1
			const { lines, joins } = wrappedRows(block.text, width - lead, color, prose)
			return lines.map((line, i) =>
				row(
					[
						i === 0 ? { text: `${marker} `, color: theme.text.muted } : { text: ' '.repeat(lead) },
						...line,
					],
					i === 0 ? null : (joins[i] ?? null),
					i === 0 ? 0 : lead,
				),
			)
		}
		case 'table':
			return layoutTable(block, width, { hyperlinks: false }).lines.map((line) =>
				row(line.map((span) => styled(span, color))),
			)
		case 'code': {
			// At the indentation of its fence, as `Markdown.tsx` draws it; a copy that
			// joins a wrapped line starts after the indentation.
			const indent = codeIndent(block, width)
			const pad = indent > 0 ? [{ text: ' '.repeat(indent) }] : []
			const lines = block.lines.length > 0 ? block.lines : ['']
			// The same colours the normal transcript draws: syntax colour for a language we
			// know once its grammar is read, the one code colour for every other line.
			grammarState(block.lang)
			const coloured = colourLines(block.lang, lines, { above: '', block: 0, spent })
			return lines.flatMap((line, n) =>
				keptLineRows(line, coloured?.lines[n], width - indent, indent, pad),
			)
		}
		default: {
			const { lines, joins } = wrappedRows(block.text, width, color, prose)
			return lines.map((line, i) => row(line, joins[i] ?? null))
		}
	}
}

/**
 * The rows of one code line, kept. A code block that streams is one block that grows by a line
 * or two at every piece, so the block's rows cannot be kept whole; its lines can: a line's rows
 * are the line, the width, the indentation, the colour of each of its runs and the theme, and
 * nothing else. Without this every line of the block was cut, joined and coloured again at every
 * piece after it (a reply of 1 MB of code cost the square of its length). Bounded like the blocks.
 */
const keptLines = new Map<string, MarkdownRow[]>()
let keptLineChars = 0

function keptLineRows(
	line: string,
	runs: CodeLine | undefined,
	room: number,
	indent: number,
	pad: StyledSpan[],
): MarkdownRow[] {
	const sig = runs ? runs.map((run) => `${run.kind ?? ''}:${run.text.length}`).join(',') : '-'
	const key = `${shownTheme()}|${room}|${indent}|${sig}|${line}`
	const hit = keptLines.get(key)
	if (hit) {
		keptLines.delete(key)
		keptLines.set(key, hit)
		return hit
	}
	const pieces = wrapCodeLine(line, room)
	const joins = wrapJoiners(line, pieces)
	const cut = runs ? runsForPieces(line, runs, pieces) : undefined
	const made = pieces.map((piece, i) => {
		const body = cut?.[i]
		const spans: StyledSpan[] = body
			? body.length === 0
				? [{ text: ' ', color: theme.text.primary }]
				: body.map((run) => ({
						text: run.text,
						color: run.kind ? theme.code[run.kind] : theme.text.primary,
					}))
			: [{ text: piece.length > 0 ? piece : ' ', color: theme.status.ok }]
		return row([...pad, ...spans], i === 0 ? null : (joins[i] ?? null), indent)
	})
	keptLines.set(key, made)
	keptLineChars += key.length
	for (const old of keptLines.keys()) {
		if (keptLineChars <= KEPT_BLOCK_CHARS || keptLines.size <= 1) break
		keptLines.delete(old)
		keptLineChars -= old.length
	}
	return made
}

/**
 * The rows of blocks already laid out. A reply that streams is laid out again
 * at every piece, but only its last block has changed: the ones before it are
 * the same text at the same width and colour, so their rows are kept instead of
 * being wrapped and coloured again. Without this a long code block earlier in
 * a reply was cut and coloured at every piece that came after it, and the
 * window stopped answering keys while it streamed.
 *
 * Bounded by the characters the kept blocks hold, oldest out, and not by a count of
 * blocks: a reply laid out again at every piece reads its blocks in order, so a bound
 * smaller than the reply's number of blocks lets each one go before it is read again
 * and every block is laid out at every piece (a long prose reply cost the square of its
 * length). The bound is the size of the reply the screen is built for.
 * The key holds everything the rows depend on:
 * the block, the width, the colour, the code above it (a grammar carries over
 * from block to block), the theme and the grammars loaded.
 */
export const KEPT_BLOCK_CHARS = 4_000_000
const keptBlocks = new Map<string, MarkdownRow[]>()
let keptChars = 0

function keptBlockRows(
	block: MdBlock,
	width: number,
	color: string,
	italic: boolean,
	spent: number,
): MarkdownRow[] {
	const key = `${shownTheme()}:${grammarVersion()}|${width}|${color}|${italic}|${spent}|${JSON.stringify(block)}`
	const hit = keptBlocks.get(key)
	if (hit) {
		// Most recently used goes last.
		keptBlocks.delete(key)
		keptBlocks.set(key, hit)
		return hit
	}
	const made = blockRows(block, width, color, italic, spent)
	keptBlocks.set(key, made)
	keptChars += key.length
	// The block just made stays, however large; the oldest go until the rest fits.
	for (const old of keptBlocks.keys()) {
		if (keptChars <= KEPT_BLOCK_CHARS || keptBlocks.size <= 1) break
		keptBlocks.delete(old)
		keptChars -= old.length
	}
	return made
}

/** Blocks as rows, one blank row between them, none before the first, bullets tight. */
function blocksRows(
	blocks: readonly MdBlock[],
	width: number,
	color: string,
	italic: boolean,
	spent = 0,
): MarkdownRow[] {
	const rows: MarkdownRow[] = []
	let above = spent
	blocks.forEach((block, i) => {
		const prev = blocks[i - 1]
		if (blockGap(block, prev?.type)) rows.push(row([]))
		for (const made of keptBlockRows(block, width, color, italic, above)) rows.push(made)
		above += codeChars(block)
	})
	return rows
}

/**
 * The rows of `text` at `width` cells of text, in `color` for plain prose.
 * Nothing is drawn beside the rows: a gutter is the caller's.
 */
export function markdownRows(text: string, width: number, color: string): MarkdownRow[] {
	return blocksRows(parseMarkdown(terminalDisplayText(text)), width, color, false)
}
