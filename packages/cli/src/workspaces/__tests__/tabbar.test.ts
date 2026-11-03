import { describe, expect, it } from 'vitest'
import { ATTR_BOLD, ATTR_INVERSE } from '../../terminal/host/cell.js'
import { Frame } from '../../terminal/host/frame.js'
import { TAB_BAR_HEIGHT, computeLayout } from '../layout.js'
import { paletteFor } from '../palette.js'
import { Roster } from '../roster.js'
import { drawTabBar, ellipsize, layoutTabBar, tabBarTarget, tabLabel } from '../tabbar.js'

function workspace(tabs: number) {
	const roster = new Roster()
	const s = roster.addWorkspace('/w', 'w')
	for (let i = 0; i < tabs; i++) roster.addTab(s, roster.addSession(s, `slot-${i}`))
	return s
}

const AREA = { x: 26, y: 0, width: 134, height: TAB_BAR_HEIGHT }

describe('the tab bar', () => {
	it('numbers a tab until it is named and marks a zoomed one', () => {
		const s = workspace(2)
		const [first, second] = s.tabs
		if (!first || !second) throw new Error('no tabs')
		second.name = 'build'
		expect(tabLabel(first, 0)).toBe('1')
		expect(tabLabel(second, 1)).toBe('build')
		first.zoomed = true
		expect(tabLabel(first, 0)).toBe('1 Z')
	})

	it('puts eight-cell tabs one cell apart with the plus after the last', () => {
		const s = workspace(2)
		const bar = layoutTabBar(s, AREA)
		expect(bar.chips.map((c) => c.rect)).toEqual([
			{ x: 26, y: 0, width: 8, height: 1 },
			{ x: 35, y: 0, width: 8, height: 1 },
		])
		expect(bar.plus).toEqual({ x: 44, y: 0, width: 3, height: 1 })
		expect(bar.chips.map((c) => c.active)).toEqual([true, false])
	})

	it('scrolls the first tabs away to keep the active one in view', () => {
		const s = workspace(30)
		s.activeTab = s.tabs[29]
		const bar = layoutTabBar(s, AREA)
		expect(bar.chips.at(-1)?.active).toBe(true)
		expect(bar.chips[0]?.tab).not.toBe(s.tabs[0])
		const last = bar.chips.at(-1)
		expect((last?.rect.x ?? 0) + (last?.rect.width ?? 0)).toBeLessThanOrEqual(160)
	})

	it('says what a click on a tab or the plus lands on', () => {
		const s = workspace(2)
		const bar = layoutTabBar(s, AREA)
		expect(tabBarTarget(bar, 30, 0)).toEqual({ kind: 'tab', tab: s.tabs[0] })
		expect(tabBarTarget(bar, 36, 0)).toEqual({ kind: 'tab', tab: s.tabs[1] })
		expect(tabBarTarget(bar, 34, 0)).toBeUndefined()
		expect(tabBarTarget(bar, 45, 0)).toEqual({ kind: 'new' })
		expect(tabBarTarget(bar, 45, 1)).toBeUndefined()
		expect(tabBarTarget(bar, 100, 0)).toBeUndefined()
	})
})

function named(tabs: number, names: Record<number, string> = {}) {
	const s = workspace(tabs)
	s.tabs.forEach((tab, i) => {
		const name = names[i]
		if (name !== undefined) tab.name = name
	})
	return s
}

const row = (frame: Frame, y: number, from: number, to: number): string =>
	Array.from({ length: to - from }, (_, i) => frame.cellAt(from + i, y)?.ch ?? '').join('')

describe('the tab bar geometry', () => {
	it("is two rows, and the panes start under it on the row of the sidebar's first entry", () => {
		expect(TAB_BAR_HEIGHT).toBe(2)
		const layout = computeLayout(160, 45)
		expect(layout.tabBar).toEqual({ x: 26, y: 0, width: 134, height: 2 })
		expect(layout.panes).toEqual({ x: 26, y: 2, width: 134, height: 43 })
	})

	it('puts every chip on the first row, one cell high', () => {
		const bar = layoutTabBar(workspace(3), AREA)
		for (const chip of bar.chips) expect(chip.rect).toMatchObject({ y: 0, height: 1 })
		expect(bar.plus).toMatchObject({ y: 0, height: 1 })
	})
})

describe('a tab wider than the room', () => {
	it('is cut with an ellipsis and stays the active tab instead of vanishing', () => {
		const s = named(2, { 0: 'a-very-long-tab-name-that-does-not-fit-anywhere-at-all'.repeat(3) })
		const bar = layoutTabBar(s, { x: 26, y: 0, width: 30, height: 2 })
		expect(bar.chips).toHaveLength(1)
		const [chip] = bar.chips
		expect(chip?.active).toBe(true)
		expect(chip?.rect.width).toBeLessThanOrEqual(27)
		expect(chip?.label.endsWith('…')).toBe(true)
		expect(chip?.rect.x).toBe(26)
		expect(bar.plus).toMatchObject({ x: 53, width: 3 })
	})

	it('stays visible at a width of 74 and of 40, the cases that emptied the bar', () => {
		for (const width of [74, 40, 12]) {
			const s = named(1, { 0: 'x'.repeat(100) })
			const bar = layoutTabBar(s, { x: 26, y: 0, width, height: 2 })
			expect(bar.chips, `width ${width}`).toHaveLength(1)
			expect(bar.chips[0]?.rect.width, `width ${width}`).toBeGreaterThan(0)
			const end = (bar.chips[0]?.rect.x ?? 0) + (bar.chips[0]?.rect.width ?? 0)
			expect(end).toBeLessThanOrEqual(26 + width)
		}
	})

	it('cuts a wide-character label by cells, not by characters', () => {
		const cut = ellipsize('日本語日本語日本語', 7)
		expect(cut.endsWith('…')).toBe(true)
		expect(cut.length).toBeLessThan(9)
	})
})

describe('tabs that do not all fit', () => {
	const NARROW = { x: 26, y: 0, width: 50, height: 2 }

	it('shows a window with the active tab in it and a cue for each side with tabs out of sight', () => {
		const s = workspace(12)
		s.activeTab = s.tabs[6]
		const bar = layoutTabBar(s, NARROW)
		expect(bar.chips.some((chip) => chip.active)).toBe(true)
		expect(bar.left).toBeDefined()
		expect(bar.right).toBeDefined()
		const first = bar.chips[0]
		const last = bar.chips.at(-1)
		expect(first?.rect.x).toBeGreaterThanOrEqual((bar.left?.x ?? 0) + (bar.left?.width ?? 0))
		expect((last?.rect.x ?? 0) + (last?.rect.width ?? 0)).toBeLessThanOrEqual(bar.right?.x ?? 0)
		// The plus sits at the far end, after the right cue.
		expect(bar.plus).toEqual({ x: 26 + 50 - 3, y: 0, width: 3, height: 1 })
		expect((bar.right?.x ?? 0) + (bar.right?.width ?? 0)).toBeLessThanOrEqual(bar.plus?.x ?? 0)
	})

	it('has no cue on the side that starts at the first or ends at the last tab', () => {
		const s = workspace(12)
		const atStart = layoutTabBar(s, NARROW)
		expect(atStart.left).toBeUndefined()
		expect(atStart.right).toBeDefined()
		s.activeTab = s.tabs[11]
		const atEnd = layoutTabBar(s, NARROW)
		expect(atEnd.left).toBeDefined()
		expect(atEnd.right).toBeUndefined()
	})

	it('keeps the active tab in view whichever tab is active', () => {
		for (const width of [30, 50, 80]) {
			const s = workspace(20)
			s.tabs.forEach((tab) => {
				s.activeTab = tab
				const bar = layoutTabBar(s, { x: 0, y: 0, width, height: 2 })
				expect(
					bar.chips.some((chip) => chip.active),
					`${width} ${tab.name}`,
				).toBe(true)
				for (const chip of bar.chips) {
					expect(chip.rect.x + chip.rect.width).toBeLessThanOrEqual(width)
					expect(chip.rect.x).toBeGreaterThanOrEqual(0)
				}
			})
		}
	})

	it('has no cues when every tab fits', () => {
		const bar = layoutTabBar(workspace(3), AREA)
		expect(bar.left).toBeUndefined()
		expect(bar.right).toBeUndefined()
	})

	it('says what a click on a cue lands on', () => {
		const s = workspace(12)
		s.activeTab = s.tabs[6]
		const bar = layoutTabBar(s, NARROW)
		const left = bar.left
		const right = bar.right
		if (!left || !right) throw new Error('no cues')
		expect(tabBarTarget(bar, left.x, 0)).toEqual({ kind: 'previous' })
		expect(tabBarTarget(bar, right.x, 0)).toEqual({ kind: 'next' })
		expect(tabBarTarget(bar, bar.plus?.x ?? 0, 0)).toEqual({ kind: 'new' })
	})
})

describe('drawing the bar', () => {
	const palette = paletteFor('truecolor')

	function drawn(tabs: number, area = AREA, mono = false) {
		const s = workspace(tabs)
		const frame = new Frame(160, 4)
		drawTabBar(frame, area, s, mono ? paletteFor('none') : palette)
		return { frame, s }
	}

	it('fills the active tab with the accent and ink text, and leaves the others plain', () => {
		const { frame } = drawn(3)
		const active = frame.cellAt(30, 0)
		expect(active?.bg).toBe(palette.accent)
		expect(active?.fg).toBe(palette.ink)
		expect((active?.attrs ?? 0) & ATTR_BOLD).toBe(ATTR_BOLD)
		const resting = frame.cellAt(39, 0)
		expect(resting?.bg).toBe(palette.base)
		expect(resting?.fg).toBe(palette.dim)
	})

	it('pads a label the same on both sides', () => {
		const { frame } = drawn(1)
		// Chip x 26..33, label "1" centred.
		expect(row(frame, 0, 26, 34)).toBe('   1    '.slice(0, 8))
	})

	it("draws a rule on the second row with the active tab's span heavy and in the accent", () => {
		const { frame } = drawn(2)
		expect(row(frame, 1, 26, 34)).toBe('━'.repeat(8))
		expect(frame.cellAt(26, 1)?.fg).toBe(palette.accent)
		expect(row(frame, 1, 34, 40)).toBe('─'.repeat(6))
		expect(frame.cellAt(40, 1)?.fg).toBe(palette.border)
		expect(row(frame, 1, 26, 160)).toHaveLength(134)
	})

	it('draws nothing in the cells outside the bar', () => {
		const { frame } = drawn(2)
		expect(frame.cellAt(10, 0)?.ch).toBe(' ')
		expect(row(frame, 2, 0, 160).trim()).toBe('')
	})

	it('marks the cues and shows the hidden tabs are somewhere', () => {
		const s = workspace(12)
		s.activeTab = s.tabs[6]
		const frame = new Frame(160, 4)
		drawTabBar(frame, { x: 26, y: 0, width: 50, height: 2 }, s, palette)
		expect(row(frame, 0, 26, 76)).toContain('‹')
		expect(row(frame, 0, 26, 76)).toContain('›')
		expect(row(frame, 0, 26, 76).trimEnd().endsWith('+')).toBe(true)
	})

	it('reverses the active tab where there is no colour, and sets no colour anywhere', () => {
		const { frame } = drawn(2, AREA, true)
		const active = frame.cellAt(30, 0)
		expect((active?.attrs ?? 0) & ATTR_INVERSE).toBe(ATTR_INVERSE)
		expect(active?.bg).toBe(-1)
		expect(active?.fg).toBe(-1)
		expect((frame.cellAt(39, 0)?.attrs ?? 0) & ATTR_INVERSE).toBe(0)
		// The heavy rule still marks the active tab.
		expect(row(frame, 1, 26, 34)).toBe('━'.repeat(8))
	})
})
