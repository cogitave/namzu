import { describe, expect, it } from 'vitest'
import { Roster } from '../roster.js'
import { layoutTabBar, tabBarTarget, tabLabel } from '../tabbar.js'

function space(tabs: number) {
	const roster = new Roster()
	const s = roster.addSpace('/w', 'w')
	for (let i = 0; i < tabs; i++) roster.addTab(s, roster.addSession(s, `slot-${i}`))
	return s
}

const AREA = { x: 26, y: 0, width: 134, height: 1 }

describe('the tab bar', () => {
	it('numbers a tab until it is named and marks a zoomed one', () => {
		const s = space(2)
		const [first, second] = s.tabs
		if (!first || !second) throw new Error('no tabs')
		second.name = 'build'
		expect(tabLabel(first, 0)).toBe('1')
		expect(tabLabel(second, 1)).toBe('build')
		first.zoomed = true
		expect(tabLabel(first, 0)).toBe('1 Z')
	})

	it('puts eight-cell tabs one cell apart with the plus after the last', () => {
		const s = space(2)
		const bar = layoutTabBar(s, AREA)
		expect(bar.chips.map((c) => c.rect)).toEqual([
			{ x: 26, y: 0, width: 8, height: 1 },
			{ x: 35, y: 0, width: 8, height: 1 },
		])
		expect(bar.plus).toEqual({ x: 44, y: 0, width: 3, height: 1 })
		expect(bar.chips.map((c) => c.active)).toEqual([true, false])
	})

	it('scrolls the first tabs away to keep the active one in view', () => {
		const s = space(30)
		s.activeTab = s.tabs[29]
		const bar = layoutTabBar(s, AREA)
		expect(bar.chips.at(-1)?.active).toBe(true)
		expect(bar.chips[0]?.tab).not.toBe(s.tabs[0])
		const last = bar.chips.at(-1)
		expect((last?.rect.x ?? 0) + (last?.rect.width ?? 0)).toBeLessThanOrEqual(160)
	})

	it('says what a click on a tab or the plus lands on', () => {
		const s = space(2)
		const bar = layoutTabBar(s, AREA)
		expect(tabBarTarget(bar, 30, 0)).toEqual({ kind: 'tab', tab: s.tabs[0] })
		expect(tabBarTarget(bar, 36, 0)).toEqual({ kind: 'tab', tab: s.tabs[1] })
		expect(tabBarTarget(bar, 34, 0)).toBeUndefined()
		expect(tabBarTarget(bar, 45, 0)).toEqual({ kind: 'new' })
		expect(tabBarTarget(bar, 45, 1)).toBeUndefined()
		expect(tabBarTarget(bar, 100, 0)).toBeUndefined()
	})
})
