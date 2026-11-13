/**
 * The rows the fullscreen window holds.
 *
 * A row is one physical terminal row of the conversation: a glyph in the
 * gutter, and the text beside it. `text` is the row as plain characters, the
 * one thing search and copy read; `spans` is the same row with its styling, set
 * only where a row has more than one style (rendered Markdown).
 */

import type { ScrollRow } from '../transcript-scroll.js'

/** A run of text drawn in one style. */
export interface StyledSpan {
	readonly text: string
	readonly color?: string
	readonly bold?: boolean
	readonly italic?: boolean
	readonly underline?: boolean
	readonly inverse?: boolean
	/** The quiet background behind the text; a selection's inverse is drawn over it. */
	readonly background?: string
}

/** How a row joins the row above it when the two were one line before wrapping. */
export type Joiner = '' | ' '

export interface FsRow extends ScrollRow {
	/** The row with its styling; absent when `text` in `color` is all there is. */
	readonly spans?: readonly StyledSpan[]
	/**
	 * Null when the row starts a line of its own. Otherwise the row continues the
	 * one above, and this is what stood between them before the wrap took it:
	 * a space where the line broke at one, nothing where a word was cut.
	 */
	readonly joins: Joiner | null
	/** Cells of hanging indent a continuation row starts with: not text, dropped on a join. */
	readonly lead: number
	/** A click on this row opens its message in place, or folds it when it is open. */
	readonly opens?: true
	/**
	 * A quiet rule drawn across the row, which is no text: `text` is empty, so a
	 * search does not find it and a copy does not take it. It marks where the
	 * replies the reader has not seen begin.
	 */
	readonly mark?: string
}

export function plainRow(row: ScrollRow, joins: Joiner | null = null): FsRow {
	return { ...row, joins, lead: 0 }
}

export function spansText(spans: readonly StyledSpan[]): string {
	let text = ''
	for (const span of spans) text += span.text
	return text
}
