import { THEME_TOKEN_NAMES } from '../shared/extension-ui.js'
import type { PageBounds } from '../shared/extension-ui.js'

/** The measuring a page's frame does, apart from the screen so it can be tested as data. */

/** Namzu's own tokens as the app's page defines them, copied by name to the names a page may use. */
const SOURCE: Record<(typeof THEME_TOKEN_NAMES)[number], string> = {
	'--ns-bg': '--background',
	'--ns-surface': '--card',
	'--ns-fg': '--foreground',
	'--ns-muted': '--muted-foreground',
	'--ns-border': '--border',
	'--ns-accent': '--primary',
	'--ns-font': '--font-sans',
	'--ns-radius': '--radius',
}

export function themeTokens(read: (cssVariable: string) => string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const name of THEME_TOKEN_NAMES) {
		const v = (read(SOURCE[name]) || (name === '--ns-surface' ? read('--background') : '')).trim()
		if (v) out[name] = v
	}
	return out
}

export interface Rect {
	left: number
	top: number
	width: number
	height: number
}

const overlap = (a: Rect, b: Rect): Rect | undefined => {
	const left = Math.max(a.left, b.left)
	const top = Math.max(a.top, b.top)
	const right = Math.min(a.left + a.width, b.left + b.width)
	const bottom = Math.min(a.top + a.height, b.top + b.height)
	return right > left && bottom > top
		? { left, top, width: right - left, height: bottom - top }
		: undefined
}

/**
 * The rectangle the page's view may take, in window coordinates, whole pixels, never negative in size.
 * A native view always paints above the window's own screens, so it is cut to what is really visible:
 * the slot's rectangle meets every scrolling ancestor's visible area and the window, and when nothing is
 * left, or one of Namzu's own overlays (a dialog, a menu, a notice) lies over the slot, the view is
 * given no area at all, so it can never cover Namzu's strip, title or buttons.
 */
export function boundsOf(
	rect: Rect,
	clips: readonly Rect[] = [],
	covers: readonly Rect[] = [],
): PageBounds {
	let r: Rect | undefined = rect
	for (const c of clips) {
		if (!r) break
		r = overlap(r, c)
	}
	if (r && covers.some((c) => overlap(r as Rect, c))) r = undefined
	if (!r)
		return {
			x: Math.round(rect.left),
			y: Math.round(rect.top),
			width: 0,
			height: 0,
		}
	return {
		x: Math.round(r.left),
		y: Math.round(r.top),
		width: Math.max(0, Math.round(r.width)),
		height: Math.max(0, Math.round(r.height)),
	}
}

export const sameBounds = (a: PageBounds | undefined, b: PageBounds): boolean =>
	a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
