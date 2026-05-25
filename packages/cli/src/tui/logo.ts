/**
 * Brand mark — a terminal homage to the namzu bloom icon (the radial
 * teal/green flower from namzu.ai). A terminal can't render the SVG, so we
 * use a flower glyph in the icon's signature green as the compact fallback
 * when the terminal is too narrow for the wordmark.
 */
export const NAMZU_MARK = '❀'
export const NAMZU_MARK_COLOR = '#7de5c3'

/**
 * Header wordmark — "NAMZU" in a solid filled-block pixel font (thick `█`
 * strokes, not thin line-art, so it reads as a chunky logo rather than an
 * outline). Five rows, every row the same width so the block stays
 * rectangular and aligned beside the name/version/cwd column.
 */
export const NAMZU_WORDMARK: readonly string[] = [
	'█   █   ███   █   █  █████  █   █',
	'██  █  █   █  ██ ██     █   █   █',
	'█ █ █  █████  █ █ █    █    █   █',
	'█  ██  █   █  █   █   █     █   █',
	'█   █  █   █  █   █  █████   ███ ',
]

/** Per-row teal→green gradient, matching the namzu.ai bloom palette. */
export const NAMZU_WORDMARK_GRADIENT: readonly string[] = [
	'#a4edd5',
	'#7de5c3',
	'#5eead4',
	'#34d399',
	'#2dd4bf',
]

/**
 * Minimum terminal columns to show the wordmark beside the text block; below
 * this the Banner falls back to the one-glyph `NAMZU_MARK`.
 */
export const NAMZU_WORDMARK_MIN_WIDTH = 62
