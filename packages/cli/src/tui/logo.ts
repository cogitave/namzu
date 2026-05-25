/**
 * Startup wordmark. "NAMZU" in the ANSI Shadow block style, rendered as a
 * vertical teal→violet gradient (one hue per row) for a premium splash.
 * Shown only when the terminal is wide enough; a compact one-line mark is
 * used otherwise (see Banner in App.tsx).
 */

export const NAMZU_LOGO: readonly string[] = [
	'███╗   ██╗ █████╗ ███╗   ███╗███████╗██╗   ██╗',
	'████╗  ██║██╔══██╗████╗ ████║╚══███╔╝██║   ██║',
	'██╔██╗ ██║███████║██╔████╔██║  ███╔╝ ██║   ██║',
	'██║╚██╗██║██╔══██║██║╚██╔╝██║ ███╔╝  ██║   ██║',
	'██║ ╚████║██║  ██║██║ ╚═╝ ██║███████╗╚██████╔╝',
	'╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝ ╚═════╝ ',
]

/** Per-row gradient colors (teal → sky → blue → indigo → violet → purple). */
export const NAMZU_LOGO_GRADIENT: readonly string[] = [
	'#5eead4',
	'#38bdf8',
	'#3b82f6',
	'#6366f1',
	'#8b5cf6',
	'#a855f7',
]

/** Minimum terminal columns required to show the full logo without wrapping. */
export const NAMZU_LOGO_MIN_WIDTH = 48

/**
 * Brand mark — a terminal homage to the namzu bloom icon (the radial
 * teal/green flower from namzu.ai). A terminal can't render the SVG, so we
 * use a flower glyph in the icon's signature green above the wordmark.
 */
export const NAMZU_MARK = '❀'
export const NAMZU_MARK_COLOR = '#7de5c3'
