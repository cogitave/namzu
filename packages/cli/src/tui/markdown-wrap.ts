/**
 * Word wrapping for styled inline text, measured in terminal cells.
 *
 * ## Why the transcript wraps its own prose
 *
 * Ink wraps a `<Text>` with `wrap-ansi` and `trim: false`. When a word ends
 * exactly at the right edge, the space after it becomes the first character of
 * the next row, so a wrapped paragraph showed a ragged one-column indent on
 * some of its rows (`  Cevabı …` under `  …araştır.`), and a word exactly as
 * wide as the row left a row holding nothing but that space. Text wrapped here
 * breaks at the space and drops it, so every row starts in the column the first
 * one did; Ink then sees rows that already fit and leaves them alone.
 *
 * A table cell needs the same thing with a narrower width, which is the other
 * reason this exists: a cell is wrapped to its column, inline styles and all.
 *
 * ## Width
 *
 * Every grapheme is measured with `string-width`, the measure Ink itself lays
 * out with, so a CJK character or an emoji is two cells and a combining mark
 * rides on the letter before it. A word wider than the row is broken between
 * graphemes, never inside one: a URL longer than the terminal continues on the
 * next row rather than being cut at the edge.
 *
 * Pure; unit-tested.
 */

import stringWidth from 'string-width'

import { type InlineSpan, parseInline } from './markdownParser.js'
import { terminalWebHyperlink } from './terminal-hyperlinks.js'

/** An inline span as it is drawn: a link's trailing ` (url)` is its own muted span. */
export interface DisplaySpan extends InlineSpan {
	/** Dim secondary text, such as the address after a link's label. */
	readonly muted?: boolean
}

export type DisplayLine = readonly DisplaySpan[]

/**
 * Inline markdown as the spans it is drawn with. A link's address follows its
 * label, dim, unless the terminal will draw the label as the link itself — the
 * address is text on the row, so it has to be measured with the row.
 */
export function inlineDisplaySpans(source: string, hyperlinks: boolean): DisplaySpan[] {
	const spans: DisplaySpan[] = []
	for (const span of parseInline(source)) {
		spans.push(span)
		const linked =
			hyperlinks && span.link ? terminalWebHyperlink(span.text, span.link) !== null : false
		if (span.link && !linked && span.link !== span.text) {
			spans.push({ text: ` (${span.link})`, muted: true })
		}
	}
	return spans
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface Glyph {
	readonly text: string
	readonly width: number
	/** Index of the span this grapheme came from, for its style. */
	readonly span: number
	readonly space: boolean
	readonly newline: boolean
}

function glyphsOf(spans: readonly DisplaySpan[]): Glyph[] {
	const glyphs: Glyph[] = []
	spans.forEach((span, index) => {
		for (const { segment } of segmenter.segment(span.text)) {
			const newline = segment === '\n'
			const space = !newline && /^\s+$/u.test(segment)
			// A tab is drawn as the spaces it stands for: its terminal width
			// depends on the column it lands in, which a measure cannot know.
			const tab = segment === '\t'
			glyphs.push({
				text: tab ? '    ' : segment,
				width: newline ? 0 : tab ? 4 : space ? 1 : stringWidth(segment),
				span: index,
				space,
				newline,
			})
		}
	})
	return glyphs
}

/** Terminal cells a run of spans occupies on one row. */
export function displayWidth(spans: readonly DisplaySpan[]): number {
	let width = 0
	for (const span of spans) width += stringWidth(span.text)
	return width
}

/** The widest single word, in cells: the narrowest a column can be without breaking one. */
export function longestWordWidth(spans: readonly DisplaySpan[]): number {
	let longest = 0
	let current = 0
	for (const glyph of glyphsOf(spans)) {
		if (glyph.space || glyph.newline) current = 0
		else {
			current += glyph.width
			if (current > longest) longest = current
		}
	}
	return longest
}

/**
 * Split styled text into rows no wider than `width` cells.
 *
 * Breaks at whitespace, dropping the space it breaks at; a `\n` always breaks,
 * and the indentation at the start of a source line is kept. A word that does
 * not fit on a row of its own is broken between graphemes. Always returns at
 * least one row, possibly empty.
 */
export function wrapSpans(spans: readonly DisplaySpan[], width: number): DisplayLine[] {
	const room = Math.max(1, Math.floor(width))
	const glyphs = glyphsOf(spans)
	const rows: Glyph[][] = []
	let row: Glyph[] = []
	let rowWidth = 0
	/** At the start of a source line (after `\n`, or at the very start), indentation is kept. */
	let lineStart = true
	let i = 0

	const endRow = () => {
		rows.push(row)
		row = []
		rowWidth = 0
	}

	while (i < glyphs.length) {
		const glyph = glyphs[i] as Glyph
		if (glyph.newline) {
			endRow()
			lineStart = true
			i += 1
			continue
		}
		// A run of whitespace, then the word after it.
		let j = i
		while (j < glyphs.length && (glyphs[j] as Glyph).space) j += 1
		const spaces = glyphs.slice(i, j)
		let k = j
		while (k < glyphs.length && !(glyphs[k] as Glyph).space && !(glyphs[k] as Glyph).newline) k += 1
		const word = glyphs.slice(j, k)
		const spaceWidth = spaces.reduce((sum, g) => sum + g.width, 0)
		const wordWidth = word.reduce((sum, g) => sum + g.width, 0)
		i = k

		if (lineStart) {
			// Leading indentation belongs to the line; keep what fits.
			for (const g of spaces) {
				if (rowWidth + g.width > room) break
				row.push(g)
				rowWidth += g.width
			}
			lineStart = false
		} else if (word.length === 0) {
			// Whitespace with nothing after it on this line is dropped.
			continue
		} else if (row.length === 0) {
			// The start of a wrapped row: the space it wrapped at is dropped.
		} else if (rowWidth + spaceWidth + wordWidth <= room) {
			row.push(...spaces)
			rowWidth += spaceWidth
		} else if (wordWidth <= room) {
			// The word goes to the next row; the space it broke at is dropped.
			endRow()
		} else if (rowWidth + spaceWidth < room) {
			// Too long for any row: start it here, after the space, and let it
			// run on to the rows below.
			row.push(...spaces)
			rowWidth += spaceWidth
		} else endRow()

		for (const g of word) {
			if (rowWidth + g.width > room && row.length > 0) endRow()
			row.push(g)
			rowWidth += g.width
		}
	}
	rows.push(row)

	return rows.map((glyphRow) => {
		const line: DisplaySpan[] = []
		let current: { span: number; text: string } | undefined
		for (const g of glyphRow) {
			if (current && current.span === g.span) current.text += g.text
			else {
				if (current) line.push({ ...(spans[current.span] as DisplaySpan), text: current.text })
				current = { span: g.span, text: g.text }
			}
		}
		if (current) line.push({ ...(spans[current.span] as DisplaySpan), text: current.text })
		return line
	})
}
