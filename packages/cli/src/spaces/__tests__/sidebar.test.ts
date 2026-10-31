import { describe, expect, it } from 'vitest'
import { rgb } from '../../terminal/host/cell.js'
import { Frame } from '../../terminal/host/frame.js'
import { RAIL_WIDTH, computeLayout } from '../layout.js'
import { paletteFor } from '../palette.js'
import { Roster } from '../roster.js'
import {
	type SidebarModel,
	agentDetail,
	agentList,
	drawSidebar,
	geometry,
	hitTest,
	ruleRow,
} from '../sidebar.js'

const palette = paletteFor(true)

function build() {
	const roster = new Roster()
	const a = roster.addSpace('/w/alpha', 'alpha')
	const a1 = roster.addSession(a, 's1')
	roster.addTab(a, a1)
	const a2 = roster.addSession(a, 's2')
	roster.addTab(a, a2)
	const b = roster.addSpace('/w/beta', 'beta')
	const b1 = roster.addSession(b, 's3')
	roster.addTab(b, b1)
	return { roster, a1, a2, b1 }
}

function model(roster: Roster, extra: Partial<SidebarModel> = {}): SidebarModel {
	return {
		roster,
		mode: 'terminal',
		foot: [],
		scroll: { spaces: 0, agents: 0 },
		palette,
		git: () => undefined,
		order: 'grouped',
		split: 0.5,
		rail: false,
		...extra,
	}
}

function draw(m: SidebarModel, width = 25, height = 45) {
	const frame = new Frame(width, height)
	drawSidebar(frame, { x: 0, y: 0, width, height }, m)
	const text = (y: number) =>
		Array.from({ length: width }, (_, x) => frame.cellAt(x, y)?.ch || ' ').join('')
	return { frame, text }
}

describe('the sidebar', () => {
	it('draws two-line space rows: dot and bold name, then the branch with arrows in colour', () => {
		const { roster } = build()
		const git = (cwd: string) =>
			cwd === '/w/alpha' ? { branch: 'feat/x', ahead: 2, behind: 1 } : undefined
		const { frame, text } = draw(model(roster, { git }))
		expect(text(0)).toBe(' spaces                  ')
		expect(text(2)).toMatch(/^ ○? ?alpha|^ [●○·] alpha/u)
		expect(text(3)).toBe('   feat/x ↑2 ↓1          ')
		// Focused: bold, main text colour, mauve branch, faint tint on both lines.
		expect(frame.cellAt(3, 2)?.attrs).toBe(1)
		expect(frame.cellAt(3, 2)?.fg).toBe(palette.text)
		expect(frame.cellAt(3, 3)?.fg).toBe(palette.mauve)
		expect(frame.cellAt(3, 3)?.bg).toBe(rgb(30, 30, 46))
		expect(frame.cellAt(10, 3)?.bg).toBe(rgb(30, 30, 46))
		expect(frame.cellAt(10, 3)?.fg).toBe(palette.green)
		expect(frame.cellAt(13, 3)?.fg).toBe(palette.red)
		// Not focused: subdued, not bold, no tint.
		expect(text(4)).toContain('beta')
		expect(frame.cellAt(3, 4)?.attrs).toBe(0)
		expect(frame.cellAt(3, 4)?.fg).toBe(palette.subtext)
		expect(frame.cellAt(3, 4)?.bg).toBe(-1)
	})

	it('tints the cursor row more strongly while navigating', () => {
		const { roster } = build()
		const { frame } = draw(model(roster, { mode: 'navigate' }))
		expect(frame.cellAt(3, 2)?.bg).toBe(rgb(49, 50, 68))
	})

	it('puts new and menu on the last row of the spaces section, above the rule', () => {
		const { roster } = build()
		const geo = geometry(45, 0, 0.5, false)
		const { text } = draw(model(roster))
		expect(text(geo.footerY as number)).toBe(' new                 menu')
		expect(text(geo.ruleY)).toBe('─'.repeat(25))
		expect(text(geo.agentHeaderY as number)).toBe(' agents           grouped')
		expect(geo.ruleY).toBe(23)
		expect(text(44).trimEnd().endsWith('«')).toBe(true)
	})

	it('lists every session of every space under the rule with its tab, pane and account', () => {
		const { roster, a1, b1 } = build()
		a1.account = 'work'
		const { text } = draw(model(roster))
		const top = geometry(45, 0, 0.5, false).agentTop
		expect(text(top)).toContain('alpha')
		expect(text(top + 1)).toBe('   1 · session 1 · work  ')
		expect(text(top + 4)).toContain('beta')
		expect(text(top + 5)).toBe('   session 1             ')
		expect(agentDetail(roster, a1, 12)).toMatch(/·? ?work$/u)
		expect(roster.entries).toContain(b1)
	})

	it('replaces an agent line with the warning when its account is out of allowance', () => {
		const { roster, a1 } = build()
		a1.limited = true
		const { text } = draw(model(roster))
		expect(text(geometry(45, 0, 0.5, false).agentTop + 1)).toContain('may be limited')
	})

	it('colours a blocked space red and a finished one teal, with the note in place of the branch', () => {
		const { roster, a1, b1 } = build()
		a1.reported = 'awaiting-permission'
		a1.child = { status: 'running' } as never
		b1.child = { status: 'running' } as never
		b1.reported = 'idle'
		b1.unseen = true
		const { frame, text } = draw(model(roster))
		expect(frame.cellAt(1, 2)?.fg).toBe(palette.red)
		expect(text(3)).toContain('needs approval')
		expect(frame.cellAt(1, 4)?.fg).toBe(palette.teal)
		expect(text(5)).toContain('finished')
		// Something wants a look, so menu carries a dot.
		expect(text(geometry(45, 0, 0.5, false).footerY as number)).toContain('● menu')
	})

	it('orders agents by priority: blocked, finished, working, idle, then newest change', () => {
		const { roster, a1, a2, b1 } = build()
		for (const e of [a1, a2, b1]) e.child = { status: 'running' } as never
		a1.reported = 'idle'
		a2.reported = 'busy'
		b1.reported = 'awaiting-permission'
		for (const e of [a1, a2, b1]) roster.update(e)
		expect(agentList(roster, 'grouped')).toEqual([a1, a2, b1])
		expect(agentList(roster, 'priority')).toEqual([b1, a2, a1])
	})

	it('draws the rail as an index and a dot per row, a rule, then the agents, and a » at the foot', () => {
		const { roster } = build()
		const { frame, text } = draw(model(roster, { rail: true }), RAIL_WIDTH - 1)
		expect(text(0)).toBe('1 ·')
		expect(text(1)).toBe('2 ·')
		expect(text(23)).toBe('───')
		expect(text(24)).toBe('1 ·')
		expect(text(26)).toBe('3 ·')
		expect(text(44)).toBe(' » ')
		expect(frame.cellAt(0, 0)?.fg).toBe(palette.dim)
	})

	it('finds what a click lands on', () => {
		const { roster, a1, b1 } = build()
		const m = model(roster)
		const at = (x: number, y: number) => hitTest(m, 25, 45, x, y)
		expect(at(5, 2)?.kind).toBe('space')
		expect(at(5, 3)).toEqual({ kind: 'space', space: roster.spaces[0] })
		expect(at(5, 4)).toEqual({ kind: 'space', space: roster.spaces[1] })
		expect(at(1, 22)).toEqual({ kind: 'new' })
		expect(at(23, 22)).toEqual({ kind: 'menu' })
		expect(at(10, 22)).toBeUndefined()
		expect(at(10, 23)).toEqual({ kind: 'split' })
		expect(at(22, 24)).toEqual({ kind: 'order' })
		expect(at(2, 24)).toBeUndefined()
		expect(at(5, 26)).toEqual({ kind: 'agent', entry: a1 })
		expect(at(5, 30)).toEqual({ kind: 'agent', entry: b1 })
		expect(at(24, 44)).toEqual({ kind: 'collapse' })
	})

	it('keeps each section at least three rows', () => {
		expect(ruleRow(45, 0.5)).toBe(23)
		expect(ruleRow(45, 0.01)).toBe(3)
		expect(ruleRow(45, 0.99)).toBe(41)
	})
})

describe('the layout', () => {
	it('is 26 columns wide with its rule, clamps a dragged width, and gives way to the rail then to nothing', () => {
		expect(computeLayout(160, 45).main.x).toBe(26)
		expect(computeLayout(160, 45, { collapsed: false, width: 99 }).main.x).toBe(36)
		expect(computeLayout(160, 45, { collapsed: false, width: 2 }).main.x).toBe(18)
		const narrow = computeLayout(60, 20)
		expect(narrow.rail).toBe(true)
		expect(narrow.main.x).toBe(RAIL_WIDTH)
		expect(computeLayout(42, 20).sidebar).toBeUndefined()
		const rail = computeLayout(160, 45, { collapsed: true, width: 26 })
		expect(rail.rule?.x).toBe(RAIL_WIDTH - 1)
	})
})
