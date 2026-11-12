/**
 * A reply's Markdown as rows, for the fullscreen window.
 *
 * The window is a list of rows, so the Markdown is laid out to rows here; it
 * does not draw anything the normal transcript does not. Every choice is the
 * one `Markdown.tsx` makes, from the same parser, the same wrapper and the same
 * table layout: what each block looks like, the blank row between blocks, how a
 * bullet hangs, and how a code line too long for a row is cut. The tests draw
 * both and compare the screens, so the two cannot drift apart unseen.
 */

import { Box, Text, renderToString } from 'ink'
import { createElement } from 'react'
import stringWidth from 'string-width'

import { QUOTE_BAR, QUOTE_BAR_WIDTH, headingStyle, ruleWidth } from '../markdown-structure.js'
import { layoutTable } from '../markdown-table.js'
import type { TableSpan } from '../markdown-table.js'
import { type DisplaySpan, inlineDisplaySpans, wrapSpans } from '../markdown-wrap.js'
import { type MdBlock, parseMarkdown } from '../markdownParser.js'
import { terminalDisplayText } from '../terminal-display.js'
import { theme } from '../theme.js'
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

/**
 * A code line cut to rows of `width` cells by the same wrapper the normal
 * transcript's `<Text wrap="wrap">` uses, which is Ink's: asked of Ink itself
 * so that where it cuts is never a second opinion.
 */
function codeLine(line: string, width: number): string[] {
	if (stringWidth(line) <= width) return [line]
	const drawn = renderToString(
		createElement(Box, { width }, createElement(Text, { wrap: 'wrap' }, line)),
		{ columns: width },
	)
	return drawn.split('\n')
}

function blockRows(block: MdBlock, width: number, color: string, italic: boolean): MarkdownRow[] {
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
					? blocksRows(block.blocks, width - QUOTE_BAR_WIDTH, color, true)
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
		case 'code':
			return (block.lines.length > 0 ? block.lines : ['']).flatMap((line) => {
				const pieces = codeLine(line, width)
				const joins = wrapJoiners(line, pieces)
				return pieces.map((piece, i) =>
					row(
						[{ text: piece.length > 0 ? piece : ' ', color: theme.status.ok }],
						i === 0 ? null : (joins[i] ?? null),
					),
				)
			})
		default: {
			const { lines, joins } = wrappedRows(block.text, width, color, prose)
			return lines.map((line, i) => row(line, joins[i] ?? null))
		}
	}
}

/** Blocks as rows, one blank row between them, none before the first, bullets tight. */
function blocksRows(
	blocks: readonly MdBlock[],
	width: number,
	color: string,
	italic: boolean,
): MarkdownRow[] {
	const rows: MarkdownRow[] = []
	blocks.forEach((block, i) => {
		const prev = blocks[i - 1]
		const gap = !prev || (block.type === 'bullet' && prev.type === 'bullet') ? 0 : 1
		if (gap) rows.push(row([]))
		rows.push(...blockRows(block, width, color, italic))
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
