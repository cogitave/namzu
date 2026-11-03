import type { Rect } from '../terminal/host/frame.js'

export interface Layout {
	readonly sidebar: Rect | undefined
	/** True when the sidebar is the thin rail of dots instead of the full lists. */
	readonly rail: boolean
	/** The one-column rule between the sidebar and the session; it is also the handle that resizes the sidebar. */
	readonly rule: Rect | undefined
	/** The pane area: the tab bar and the panes under it. */
	readonly main: Rect
	/** The one-row tab bar across the top of the main area. */
	readonly tabBar: Rect
	/** What is left for the panes. */
	readonly panes: Rect
}

/** What the user chose for the sidebar. */
export interface SidebarSetting {
	readonly collapsed: boolean
	/** The full sidebar's width, rule included. */
	readonly width: number
}

export const SIDEBAR_MIN = 18
export const SIDEBAR_MAX = 36
export const SIDEBAR_DEFAULT = 26
/** The rail's width, rule included: an index, a gap and a dot. */
export const RAIL_WIDTH = 4
/** The session never gets fewer columns than this; below it the sidebar steps aside. */
const MAIN_MIN = 40

export const DEFAULT_SIDEBAR: SidebarSetting = {
	collapsed: false,
	width: SIDEBAR_DEFAULT,
}

export function clampSidebarWidth(width: number): number {
	if (!Number.isFinite(width)) return SIDEBAR_DEFAULT
	return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)))
}

/**
 * Splits the terminal into a sidebar, a rule and the main area, and the main
 * area into a tab bar and the panes. A full sidebar that would leave the session
 * too narrow gives way to the rail, and the rail to nothing.
 */
export function computeLayout(
	cols: number,
	rows: number,
	sidebar: SidebarSetting = DEFAULT_SIDEBAR,
): Layout {
	let total = sidebar.collapsed ? RAIL_WIDTH : clampSidebarWidth(sidebar.width)
	let rail = sidebar.collapsed
	if (!rail && cols - total < MAIN_MIN) {
		rail = true
		total = RAIL_WIDTH
	}
	const shown = cols - total >= MAIN_MIN
	const main: Rect = shown
		? { x: total, y: 0, width: cols - total, height: rows }
		: { x: 0, y: 0, width: cols, height: rows }
	const tabBar: Rect = { ...main, height: Math.min(1, main.height) }
	const panes: Rect = {
		...main,
		y: main.y + 1,
		height: Math.max(1, main.height - 1),
	}
	if (!shown)
		return {
			sidebar: undefined,
			rail: false,
			rule: undefined,
			main,
			tabBar,
			panes,
		}
	return {
		sidebar: { x: 0, y: 0, width: total - 1, height: rows },
		rail,
		rule: { x: total - 1, y: 0, width: 1, height: rows },
		main,
		tabBar,
		panes,
	}
}
