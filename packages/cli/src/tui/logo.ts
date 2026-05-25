/**
 * Brand mark — a terminal homage to the namzu bloom icon (the radial
 * teal/green flower from namzu.ai). A terminal can't render the SVG, so we
 * use a flower glyph in the icon's signature green as the compact fallback
 * when the terminal is too narrow for the wordmark.
 */
export const NAMZU_MARK = '❀'
export const NAMZU_MARK_COLOR = '#7de5c3'

/**
 * Header wordmark — a compact ASCII "namzu" (figlet "Small" style). Every
 * letter is x-height, so three rows are enough to read it and it stays short
 * enough to sit beside the name/version/cwd block without dwarfing it. Each
 * row is the same width, so the block stays rectangular and aligned.
 */
export const NAMZU_WORDMARK: readonly string[] = [
	' _ _    __ _   _ __   ____  _  _ ',
	"| ' \\  / _` | | '  \\ |_  / | || |",
	'|_||_| \\__,_| |_|_|_| /__|  \\_,_|',
]

/** Per-row teal→green gradient, matching the namzu.ai bloom palette. */
export const NAMZU_WORDMARK_GRADIENT: readonly string[] = ['#a4edd5', '#5eead4', '#2dd4bf']

/**
 * Minimum terminal columns to show the wordmark beside the text block; below
 * this the Banner falls back to the one-glyph `NAMZU_MARK`.
 */
export const NAMZU_WORDMARK_MIN_WIDTH = 62
