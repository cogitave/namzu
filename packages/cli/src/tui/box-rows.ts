/**
 * A bordered box as a transcript row, as plain data: a rounded border in a tone colour, a bold title,
 * body lines and dim footnote lines. Nothing here draws; `layoutBox` turns a box into the lines a
 * screen prints, wrapped inside the border. Where the room is under {@link BOX_MIN_COLUMNS} the box has
 * no border and reads as an indented block, and where the terminal draws no colour the border keeps the
 * terminal's own.
 */

import { type DisplayLine, type DisplaySpan, displayWidth, wrapSpans } from './markdown-wrap.js'

/** Under this many columns a box is a plain indented block. */
export const BOX_MIN_COLUMNS = 40

/** A box: what it says, and the colour its border and title wear. */
export interface BoxRow {
	/** A theme token or a colour; the border and the title wear it. */
	readonly tone: string
	/** The bold line at the top. */
	readonly title: readonly DisplaySpan[]
	/** The lines under the title; each wraps by itself. A line of no spans is a blank one. */
	readonly body?: readonly (readonly DisplaySpan[])[]
	/** Dim lines at the bottom. */
	readonly notes?: readonly (readonly DisplaySpan[])[]
}

export interface BoxLayoutOptions {
	/** False where the terminal draws no colour: the border and the title carry no colour of their own. */
	readonly colour?: boolean
}

/** Whether this terminal is asked to draw colour (`NO_COLOR`, `FORCE_COLOR=0` and a dumb terminal say no). */
export function boxColour(env: NodeJS.ProcessEnv = process.env): boolean {
	return !((env.NO_COLOR ?? '') !== '' || env.FORCE_COLOR === '0' || env.TERM === 'dumb')
}

const INDENT = '  '

function dim(spans: readonly DisplaySpan[]): DisplaySpan[] {
	return spans.map((span) => ({ ...span, muted: true }))
}

function wrapped(lines: readonly (readonly DisplaySpan[])[], width: number): DisplayLine[] {
	const out: DisplayLine[] = []
	for (const line of lines) {
		if (line.length === 0 || displayWidth(line) === 0) {
			out.push([])
			continue
		}
		out.push(...wrapSpans(line, width))
	}
	return out
}

function titleSpans(box: BoxRow, colour: boolean): DisplaySpan[] {
	return box.title.map((span) => ({
		...span,
		bold: true,
		...(colour && span.tone === undefined ? { tone: box.tone } : {}),
	}))
}

/** The plain words of a box, one line each, as copy and search see them. */
export function boxText(box: BoxRow): string {
	const text = (line: readonly DisplaySpan[]): string => line.map((span) => span.text).join('')
	return [text(box.title), ...(box.body ?? []).map(text), ...(box.notes ?? []).map(text)].join('\n')
}

/**
 * The lines of a box for a screen `width` cells wide. The border is as wide as its longest line (and
 * never wider than `width`); lines longer than the room wrap inside it.
 */
export function layoutBox(
	box: BoxRow,
	width: number,
	options: BoxLayoutOptions = {},
): readonly DisplayLine[] {
	const colour = options.colour !== false
	const title = titleSpans(box, colour)
	if (width < BOX_MIN_COLUMNS) {
		const room = Math.max(1, width - INDENT.length)
		const pad: DisplaySpan = { text: INDENT }
		return [
			...wrapped([title], width),
			...wrapped(box.body ?? [], room).map((line) => (line.length === 0 ? line : [pad, ...line])),
			...wrapped((box.notes ?? []).map(dim), room).map((line) =>
				line.length === 0 ? line : [pad, ...line],
			),
		]
	}
	const room = width - 4
	const content: DisplayLine[] = [
		...wrapped([title], room),
		...wrapped(box.body ?? [], room),
		...wrapped((box.notes ?? []).map(dim), room),
	]
	const inner = Math.max(1, ...content.map((line) => displayWidth(line)))
	const border = (text: string): DisplaySpan => ({
		text,
		...(colour ? { tone: box.tone } : {}),
	})
	const rule = (left: string, right: string): DisplayLine => [
		border(`${left}${'─'.repeat(inner + 2)}${right}`),
	]
	return [
		rule('╭', '╮'),
		...content.map((line): DisplayLine => {
			const fill = inner - displayWidth(line)
			return [border('│'), { text: ' ' }, ...line, { text: `${' '.repeat(fill)} ` }, border('│')]
		}),
		rule('╰', '╯'),
	]
}
