import type { Rect } from '../terminal/host/frame.js'

export interface Layout {
	readonly sidebar: Rect | undefined
	/** The one-column rule between the sidebar and the session. */
	readonly rule: Rect | undefined
	/** The workspace area: the tab bar and the panes under it. */
	readonly main: Rect
	/** The one-row tab bar across the top of the main area. */
	readonly tabBar: Rect
	/** What is left for the panes. */
	readonly panes: Rect
}

const SIDEBAR_MIN = 18
const SIDEBAR_MAX = 36
const SIDEBAR_DEFAULT = 26
/** The session never gets fewer columns than this; below it the sidebar steps aside. */
const MAIN_MIN = 40

/** Splits the terminal into a sidebar, a rule and the main area, and the main area into a tab bar and the panes. */
export function computeLayout(cols: number, rows: number, sidebarVisible: boolean): Layout {
	const width = Math.max(
		SIDEBAR_MIN,
		Math.min(SIDEBAR_MAX, Math.min(SIDEBAR_DEFAULT, Math.floor(cols / 4))),
	)
	const shown = sidebarVisible && cols - width - 1 >= MAIN_MIN
	const main: Rect = shown
		? { x: width + 1, y: 0, width: cols - width - 1, height: rows }
		: { x: 0, y: 0, width: cols, height: rows }
	const tabBar: Rect = { ...main, height: Math.min(1, main.height) }
	const panes: Rect = {
		...main,
		y: main.y + 1,
		height: Math.max(1, main.height - 1),
	}
	if (!shown) return { sidebar: undefined, rule: undefined, main, tabBar, panes }
	return {
		sidebar: { x: 0, y: 0, width, height: rows },
		rule: { x: width, y: 0, width: 1, height: rows },
		main,
		tabBar,
		panes,
	}
}
