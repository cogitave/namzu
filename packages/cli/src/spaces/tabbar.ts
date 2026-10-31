import stringWidth from 'string-width'
import { ATTR_BOLD } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { Palette } from './palette.js'
import type { Space, Tab } from './roster.js'

/** The least a tab is wide; a longer name makes it wider. */
export const MIN_TAB_WIDTH = 8
/** The width of the "add a tab" target. */
export const NEW_TAB_WIDTH = 3

export interface TabChip {
	readonly tab: Tab
	readonly rect: Rect
	readonly label: string
	readonly active: boolean
}

export interface TabBar {
	readonly chips: readonly TabChip[]
	/** The "+" target; undefined when there is no room for it. */
	readonly plus: Rect | undefined
}

/** What a tab says: its name or its number, with a Z while one of its panes is zoomed. */
export function tabLabel(tab: Tab, index: number): string {
	const base = tab.name ?? String(index + 1)
	return tab.zoomed ? `${base} Z` : base
}

/**
 * Where each tab and the "+" go in the one-row bar. Tabs are separated by one
 * cell; when they do not all fit, the first ones scroll off so the active tab
 * stays in view.
 */
export function layoutTabBar(space: Space, area: Rect): TabBar {
	const widths = space.tabs.map((tab, i) =>
		Math.max(MIN_TAB_WIDTH, stringWidth(tabLabel(tab, i)) + 4),
	)
	const room = Math.max(0, area.width - NEW_TAB_WIDTH)
	const active = space.activeTab ? space.tabs.indexOf(space.activeTab) : -1
	const span = (from: number, to: number): number =>
		widths.slice(from, to + 1).reduce((sum, w) => sum + w + 1, -1)
	let first = 0
	while (first < active && span(first, active) > room) first++
	const chips: TabChip[] = []
	let x = area.x
	for (let i = first; i < space.tabs.length; i++) {
		const width = widths[i] as number
		if (x + width > area.x + room) break
		const tab = space.tabs[i] as Tab
		chips.push({
			tab,
			rect: { x, y: area.y, width, height: 1 },
			label: tabLabel(tab, i),
			active: tab === space.activeTab,
		})
		x += width + 1
	}
	const plusX = Math.min(x, area.x + area.width - NEW_TAB_WIDTH)
	const plus =
		area.width >= NEW_TAB_WIDTH
			? { x: plusX, y: area.y, width: NEW_TAB_WIDTH, height: 1 }
			: undefined
	return { chips, plus }
}

/** Draws the bar: the active tab a filled chip, the rest quiet, and a "+". */
export function drawTabBar(frame: Frame, area: Rect, space: Space, palette: Palette): void {
	frame.fillRect(area, { bg: palette.panelBg })
	const bar = layoutTabBar(space, area)
	for (const chip of bar.chips) {
		const style: CellStyle = chip.active
			? { fg: palette.panelBg, bg: palette.accent, ...(chip.tab.name ? { attrs: ATTR_BOLD } : {}) }
			: { fg: palette.dim, bg: palette.surface }
		frame.fillRect(chip.rect, style)
		const pad = Math.max(0, chip.rect.width - stringWidth(chip.label))
		frame.writeText(chip.rect, 0, `${' '.repeat(Math.floor(pad / 2))}${chip.label}`, style)
	}
	if (bar.plus) frame.writeText(bar.plus, 0, ' + ', { fg: palette.dimmer, bg: palette.panelBg })
}

/** What a click at a cell of the bar lands on. */
export function tabBarTarget(
	bar: TabBar,
	x: number,
	y: number,
): { kind: 'tab'; tab: Tab } | { kind: 'new' } | undefined {
	const inside = (r: Rect): boolean => y === r.y && x >= r.x && x < r.x + r.width
	for (const chip of bar.chips) if (inside(chip.rect)) return { kind: 'tab', tab: chip.tab }
	if (bar.plus && inside(bar.plus)) return { kind: 'new' }
	return undefined
}
