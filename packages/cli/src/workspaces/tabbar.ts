import stringWidth from 'string-width'
import { ATTR_BOLD, ATTR_INVERSE } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import { TAB_BAR_HEIGHT } from './layout.js'
import type { Palette } from './palette.js'
import type { Tab, Workspace } from './roster.js'

/** The least a tab is wide; a longer name makes it wider. */
export const MIN_TAB_WIDTH = 8
/** The width of the "add a tab" target. */
export const NEW_TAB_WIDTH = 3
/** The width of a "more tabs this way" cue. */
export const CUE_WIDTH = 2

export interface TabChip {
	readonly tab: Tab
	/** Where the chip is: always on the bar's first row. */
	readonly rect: Rect
	/** What the chip says: the tab's label, cut with an ellipsis when the chip is narrower than it. */
	readonly label: string
	readonly active: boolean
}

export interface TabBar {
	readonly chips: readonly TabChip[]
	/** The "+" target; undefined when there is no room for it. */
	readonly plus: Rect | undefined
	/** The cue that tabs are hidden to the left, and the one for the right. */
	readonly left: Rect | undefined
	readonly right: Rect | undefined
}

/** What a tab says: its name or its number, with a Z while one of its panes is zoomed. */
export function tabLabel(tab: Tab, index: number): string {
	const base = tab.name ?? String(index + 1)
	return tab.zoomed ? `${base} Z` : base
}

/** `text` cut to `max` cells, with an ellipsis where something was left out. */
export function ellipsize(text: string, max: number): string {
	if (max <= 0) return ''
	if (stringWidth(text) <= max) return text
	let out = ''
	let used = 0
	for (const ch of text) {
		const w = stringWidth(ch)
		if (used + w > max - 1) break
		out += ch
		used += w
	}
	return `${out}…`
}

/** The tabs from `first` to `last` that fit in `room` cells with the active one among them; the active tab is cut rather than dropped. */
function visibleSpan(
	widths: readonly number[],
	active: number,
	room: number,
): { first: number; last: number } {
	let first = active
	let last = active
	let used = Math.min(widths[active] as number, room)
	for (let grew = true; grew; ) {
		grew = false
		const next = widths[last + 1]
		if (next !== undefined && used + 1 + next <= room) {
			last++
			used += 1 + next
			grew = true
		}
		const before = widths[first - 1]
		if (before !== undefined && used + 1 + before <= room) {
			first--
			used += 1 + before
			grew = true
		}
	}
	return { first, last }
}

/**
 * Where each tab, the "+" and the overflow cues go on the bar's first row. Tabs are separated by one
 * cell. When they do not all fit, a window of them stays in view with the active tab always in it,
 * a "‹" or "›" marks each side that has tabs out of sight, and the "+" moves to the far end. An
 * active tab wider than the room is cut with an ellipsis; it is never dropped.
 */
export function layoutTabBar(workspace: Workspace, area: Rect): TabBar {
	const count = workspace.tabs.length
	const widths = workspace.tabs.map((tab, i) =>
		Math.max(MIN_TAB_WIDTH, stringWidth(tabLabel(tab, i)) + 2),
	)
	const hasPlus = area.width >= NEW_TAB_WIDTH
	const room = Math.max(0, area.width - (hasPlus ? NEW_TAB_WIDTH : 0))
	const activeIndex = workspace.activeTab ? workspace.tabs.indexOf(workspace.activeTab) : -1
	const row = (x: number, width: number): Rect => ({ x, y: area.y, width, height: 1 })
	const whole = widths.reduce((sum, w) => sum + w + 1, -1)
	let first = 0
	let last = count - 1
	let needLeft = false
	let needRight = false
	let chipRoom = room
	if (whole > room && count > 0) {
		for (let pass = 0; pass < 3; pass++) {
			chipRoom = Math.max(0, room - (needLeft ? CUE_WIDTH : 0) - (needRight ? CUE_WIDTH : 0))
			const span = visibleSpan(widths, Math.max(0, activeIndex), chipRoom)
			first = span.first
			last = span.last
			const left = first > 0
			const right = last < count - 1
			if (left === needLeft && right === needRight) break
			needLeft = left
			needRight = right
		}
	}
	const chips: TabChip[] = []
	let x = area.x + (needLeft ? CUE_WIDTH : 0)
	const stop = x + chipRoom
	for (let i = first; i <= last && chipRoom > 0; i++) {
		const tab = workspace.tabs[i] as Tab
		const width = Math.min(widths[i] as number, stop - x)
		if (width <= 0) break
		chips.push({
			tab,
			rect: row(x, width),
			label: ellipsize(tabLabel(tab, i), width - 2),
			active: tab === workspace.activeTab,
		})
		x += width + 1
	}
	const overflowing = needLeft || needRight
	// Tabs that all fit have the "+" right after them; overflowing ones push it to the far end.
	const plusX = overflowing
		? area.x + area.width - NEW_TAB_WIDTH
		: Math.min(x, area.x + area.width - NEW_TAB_WIDTH)
	return {
		chips,
		plus: hasPlus ? row(plusX, NEW_TAB_WIDTH) : undefined,
		left: needLeft ? row(area.x, CUE_WIDTH) : undefined,
		right: needRight ? row(plusX - CUE_WIDTH, CUE_WIDTH) : undefined,
	}
}

/**
 * Draws the bar. Row 0 holds the chips: the active tab filled in the accent with ink text (reversed
 * where there is no colour), the rest plain muted text on the terminal's own background. Row 1 is a
 * thin rule, and the span under the active tab is drawn heavy in the accent.
 */
export function drawTabBar(frame: Frame, area: Rect, workspace: Workspace, palette: Palette): void {
	frame.fillRect(area, { bg: palette.base })
	const bar = layoutTabBar(workspace, area)
	for (const chip of bar.chips) {
		const style: CellStyle = chip.active
			? palette.mono
				? { attrs: ATTR_BOLD | ATTR_INVERSE }
				: { fg: palette.ink, bg: palette.accent, attrs: ATTR_BOLD }
			: { fg: palette.dim }
		frame.fillRect(chip.rect, style)
		const pad = Math.max(0, chip.rect.width - stringWidth(chip.label))
		frame.writeText(chip.rect, 0, `${' '.repeat(Math.floor(pad / 2))}${chip.label}`, style)
	}
	const cue = { fg: palette.accent, attrs: ATTR_BOLD }
	if (bar.left) frame.writeText(bar.left, 0, '‹', cue)
	if (bar.right) frame.writeText(bar.right, 0, '›', cue)
	if (bar.plus) frame.writeText(bar.plus, 0, ' + ', { fg: palette.dim })
	if (area.height < TAB_BAR_HEIGHT) return
	const rule = { ...area, y: area.y + 1, height: 1 }
	frame.writeText(rule, 0, '─'.repeat(area.width), { fg: palette.border })
	const active = bar.chips.find((chip) => chip.active)
	if (active)
		frame.writeText(
			{ ...rule, x: active.rect.x, width: active.rect.width },
			0,
			'━'.repeat(active.rect.width),
			{ fg: palette.accent },
		)
}

/** What a click at a cell of the bar lands on. */
export function tabBarTarget(
	bar: TabBar,
	x: number,
	y: number,
):
	| { kind: 'tab'; tab: Tab }
	| { kind: 'new' }
	| { kind: 'previous' }
	| { kind: 'next' }
	| undefined {
	const inside = (r: Rect): boolean => y === r.y && x >= r.x && x < r.x + r.width
	for (const chip of bar.chips) if (inside(chip.rect)) return { kind: 'tab', tab: chip.tab }
	if (bar.plus && inside(bar.plus)) return { kind: 'new' }
	if (bar.left && inside(bar.left)) return { kind: 'previous' }
	if (bar.right && inside(bar.right)) return { kind: 'next' }
	return undefined
}
