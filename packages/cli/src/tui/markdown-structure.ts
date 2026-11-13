/**
 * What a heading, a quote and a rule look like, in one place for the two
 * screens: the normal transcript (`Markdown.tsx`) and the fullscreen window
 * (`fullscreen/markdown-rows.ts`) both read it, so a level cannot be drawn one
 * way on one screen and another way on the other.
 */

import stringWidth from 'string-width'

/** Which colour a heading takes: the accent, the body's own, or the muted one. */
export interface HeadingStyle {
	readonly color: 'accent' | 'body' | 'muted'
	readonly underline: boolean
}

/**
 * Headings are all bold; the level is told by colour and underline, which
 * every terminal has. 1 is underlined accent, 2 accent, 3 body colour, 4 to 6
 * muted.
 */
export function headingStyle(level: number): HeadingStyle {
	if (level <= 1) return { color: 'accent', underline: true }
	if (level === 2) return { color: 'accent', underline: false }
	if (level === 3) return { color: 'body', underline: false }
	return { color: 'muted', underline: false }
}

/** The bar of a quote and the space after it, in terminal cells. */
export const QUOTE_BAR = '│'
export const QUOTE_BAR_WIDTH = stringWidth(QUOTE_BAR) + 1

/** Cells a rule is drawn across: the width there is, up to 40. */
export const RULE_MAX = 40
export function ruleWidth(width: number): number {
	return Math.max(1, Math.min(RULE_MAX, width))
}

/**
 * Blank rows above a block: one between blocks, none before the first, none
 * between consecutive list items, and none above a code block indented under
 * the list item it belongs to (the item and its block are one thing). `prev`
 * is the type of the block before, or `'join'` for text that continues one.
 */
export function blockGap(
	block: { readonly type: string; readonly indent?: number },
	prev: string | null | undefined,
): 0 | 1 {
	if (!prev || prev === 'join') return 0
	if (block.type === 'bullet' && prev === 'bullet') return 0
	if (block.type === 'code' && prev === 'bullet' && (block.indent ?? 0) > 0) return 0
	return 1
}

/** The most of a row a code block's indentation may take; the code keeps the rest. */
export function codeIndent(block: { readonly indent?: number }, width: number): number {
	return Math.max(0, Math.min(block.indent ?? 0, Math.floor(width / 2)))
}
