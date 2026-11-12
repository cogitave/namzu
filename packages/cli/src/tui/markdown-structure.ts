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
