import { afterEach, describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { applyPalette } from '../../tui/theme.js'
import type { HostAccount, SessionRequest } from '../host.js'
import type { SavedLayout, WorkspacesStore } from '../store.js'
import { leaves } from '../tiling.js'
import { setup } from './support/harness.js'

// The dark theme: the accent is palette entry 83, the border of a pane without focus 239.
const ACCENT = 83
const FOCUS = 83
const BORDER = 239

function rig(extra: Parameters<typeof setup>[1] = {}, size = { columns: 100, rows: 30 }) {
	const requests: SessionRequest[] = []
	let n = 0
	const t = setup(size, {
		colors: 'truecolor',
		newSlot: () => `slot-${++n}`,
		spec: (request) => {
			requests.push(request)
			return { file: 'node', args: ['bin.js'], cwd: request.cwd, env: {} }
		},
		...extra,
	})
	return { t, requests }
}

afterEach(() => applyPalette('dark'))

type Rig = ReturnType<typeof rig>['t']

const nav = (t: Rig, keys: string) => {
	t.type('\x02')
	t.type(keys)
}
const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`

async function rows(t: Rig): Promise<string[]> {
	await t.frame()
	return t.screen()
}

const pty = (t: Rig, i: number) => t.spawned[i] as FakePty

/** A hundred columns: the sidebar and its rule take 26, so the pane area is 74 wide from column 26. */
describe('splitting', () => {
	it('splits side by side with v: each pane gets its inside, and the new one is a session with focus', () => {
		const { t, requests } = rig()
		t.host.start()
		expect(pty(t, 0).options).toMatchObject({ cols: 74, rows: 28 })
		nav(t, 'v')
		expect(t.spawned).toHaveLength(2)
		expect(requests[1]).toMatchObject({ cwd: '/work/namzu', first: false })
		expect(requests[1]?.resume).toBeUndefined()
		// 74 columns: the first pane takes 37, one cell is left between them, the second takes 36.
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 35, rows: 26 })
		expect(pty(t, 1).options).toMatchObject({ cols: 34, rows: 26 })
		t.type('hi')
		expect(pty(t, 1).writes).toEqual(['hi'])
		expect(pty(t, 0).writes).toEqual([])
	})

	it('splits top over bottom with minus', () => {
		const { t } = rig()
		t.host.start()
		nav(t, '-')
		// 28 rows: the upper pane takes 14, one row is left between them, the lower takes 13.
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 72, rows: 12 })
		expect(pty(t, 1).options).toMatchObject({ cols: 72, rows: 11 })
	})

	it('draws a rounded border on every pane with a gap between neighbours, the focused one in the focus colour and the rest dim', async () => {
		const { t } = rig()
		t.host.start()
		expect((await rows(t))[2]?.[26]).not.toBe('╭')
		nav(t, 'v')
		nav(t, '-')
		const screen = await rows(t)
		// Left pane: columns 26 to 62. Gap: column 63. Right panes: columns 64 to 99, split at row 16.
		expect(screen[2]?.[26]).toBe('╭')
		expect(screen[2]?.[62]).toBe('╮')
		expect(screen[2]?.[63]).toBe(' ')
		expect(screen[2]?.[64]).toBe('╭')
		expect(screen[29]?.[62]).toBe('╯')
		expect(screen[2]?.slice(27, 62)).toBe('─'.repeat(35))
		expect(screen[3]?.[26]).toBe('│')
		expect(screen[15]?.[64]).toBe('╰')
		expect((screen[16] ?? '').slice(64).trim()).toBe('')
		expect(screen[17]?.[64]).toBe('╭')
		// No two border cells touch, across or down.
		for (const row of screen) expect(row.slice(26)).not.toMatch(/[│╮╯][│╭╰]/u)
		// The focused pane is the bottom right one.
		expect((await t.cellAt(64, 17))?.fg).toBe(FOCUS)
		expect((await t.cellAt(99, 29))?.fg).toBe(FOCUS)
		expect((await t.cellAt(26, 2))?.fg).toBe(BORDER)
		expect((await t.cellAt(64, 2))?.fg).toBe(BORDER)
	})

	it('uses the nearest of the 16 colours when the terminal does not show true colour', async () => {
		const { t } = rig({ colors: '16' })
		t.host.start()
		nav(t, 'v')
		await t.frame()
		const focused = (await t.cellAt(64, 2))?.fg as number
		const other = (await t.cellAt(26, 2))?.fg as number
		expect(focused).toBeGreaterThanOrEqual(0)
		expect(focused).toBeLessThan(16)
		expect(other).toBeLessThan(16)
		expect(focused).not.toBe(other)
	})

	it('follows the theme: a light theme draws the light accent from the next frame', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		await t.frame()
		expect((await t.cellAt(64, 2))?.fg).toBe(FOCUS)
		try {
			applyPalette('light')
			t.type('x')
			await t.frame()
			// Light: the focus border is entry 28, a pane without focus 250, and the active chip is filled with 28.
			expect((await t.cellAt(64, 2))?.fg).toBe(28)
			expect((await t.cellAt(26, 2))?.fg).toBe(250)
			expect((await t.cellAt(30, 0))?.bg).toBe(28)
		} finally {
			applyPalette('dark')
		}
	})

	it('draws no colour and tells the focused pane by shape under NO_COLOR', async () => {
		const { t } = rig({ colors: 'none' })
		t.host.start()
		nav(t, 'v')
		const screen = await rows(t)
		expect(screen[2]?.[26]).toBe('╭')
		for (const [x, y] of [
			[26, 2],
			[64, 2],
			[30, 0],
		] as const) {
			const cell = await t.cellAt(x, y)
			expect(cell?.fg).toBe(-1)
			expect(cell?.bg).toBe(-1)
		}
		// The active tab is reversed.
		expect(((await t.cellAt(30, 0))?.attrs ?? 0) & 32).toBe(32)
	})

	it('refuses a split that would leave a pane too small, and says so', async () => {
		const { t } = rig({}, { columns: 100, rows: 8 })
		t.host.start()
		nav(t, '-')
		expect(t.spawned).toHaveLength(1)
		expect((await rows(t)).join('\n')).toContain('not enough room')
		// The notice sits on the rule under the tab bar, at its right end.
		expect((await rows(t))[1]).toMatch(/not enough room to split this pane\. $/u)
		for (let i = 0; i < 6; i++) nav(t, 'v')
		// 74 columns hold six panes of 12 with a cell between each, never more.
		expect(t.spawned.length).toBeLessThanOrEqual(6)
	})

	it('starts the new pane on the account of the focused one, without asking', () => {
		const accounts: HostAccount[] = [{ id: 'openai:free-a', label: 'free-a', provider: 'openai' }]
		const { t, requests } = rig({ accounts: () => accounts })
		t.host.start()
		nav(t, 'c')
		t.type('j')
		t.type('\r')
		t.type('\r')
		expect(requests[1]?.account).toBe('openai:free-a')
		nav(t, 'v')
		expect(t.spawned).toHaveLength(3)
		expect(requests[2]?.account).toBe('openai:free-a')
	})
})

describe('moving between panes', () => {
	function three() {
		const r = rig()
		r.t.host.start()
		nav(r.t, 'v')
		nav(r.t, '-')
		return r.t
	}

	it('moves focus by direction and sends keys to the focused pane', () => {
		const t = three()
		// Panes: 0 left, 1 top right, 2 bottom right (focused).
		nav(t, 'k')
		t.type('a')
		expect(pty(t, 1).writes).toEqual(['a'])
		nav(t, 'h')
		t.type('b')
		expect(pty(t, 0).writes).toEqual(['b'])
		nav(t, 'l')
		t.type('c')
		// Back on the right, it lands on the upper pane, which faces the left pane's middle row.
		expect(pty(t, 1).writes.length + pty(t, 2).writes.length).toBe(2)
		nav(t, 'j')
		t.type('d')
		expect(pty(t, 2).writes).toContain('d')
		// Nothing below the bottom pane.
		nav(t, 'j')
		t.type('e')
		expect(pty(t, 2).writes).toContain('e')
	})

	it('cycles panes with tab and shift+tab', () => {
		const t = three()
		nav(t, '\t')
		expect(t.host.roster.selected?.label).toBe('session 1')
		nav(t, '\x1b[Z')
		expect(t.host.roster.selected?.label).toBe('session 3')
	})

	it('swaps the focused pane with its neighbour', () => {
		const t = three()
		nav(t, 'K')
		const tab = t.host.roster.shownTab
		expect(leaves(tab?.root as never).map((e) => e.label)).toEqual([
			'session 1',
			'session 3',
			'session 2',
		])
		// The swapped panes took each other's room.
		expect(pty(t, 2).resizes.at(-1)).toEqual({ cols: 34, rows: 12 })
		expect(t.host.roster.selected?.label).toBe('session 3')
	})
})

describe('zoom', () => {
	it('fills the area with the focused pane and marks the tab with a Z, and brings the layout back', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'z')
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 72, rows: 26 })
		let screen = await rows(t)
		expect(screen[0]).toContain('1 Z')
		expect(screen[2]?.[26]).toBe('╭')
		expect(screen[2]?.[99]).toBe('╮')
		nav(t, 'z')
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 34, rows: 26 })
		screen = await rows(t)
		expect(screen[0]).not.toContain('Z')
	})

	it('does nothing for a lone pane, and a split puts the layout back', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'z')
		expect(t.host.roster.shownTab?.zoomed).toBe(false)
		nav(t, 'v')
		nav(t, 'z')
		nav(t, 'v')
		expect(t.host.roster.shownTab?.zoomed).toBe(false)
	})
})

describe('resize mode', () => {
	it('moves the border toward h and l until escape', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		// The focused pane is on the right: l moves the border to the right, so it shrinks.
		nav(t, 'r')
		expect((await rows(t))[1] ?? '').toContain('RESIZE')
		t.type('l')
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 38, rows: 26 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 31, rows: 26 })
		t.type('h')
		t.type('h')
		expect(pty(t, 1).resizes.at(-1)?.cols).toBe(38)
		t.type('\x1b')
		t.type('l')
		// Back with the session: the key is typed into it.
		expect(pty(t, 1).writes).toEqual(['l'])
		expect((await rows(t))[1] ?? '').not.toContain('RESIZE')
	})

	it('resizes the height of a stacked pane with j and k', () => {
		const { t } = rig()
		t.host.start()
		nav(t, '-')
		nav(t, 'r')
		// The focused pane is the lower one: j moves the border down, so the upper one grows.
		t.type('j')
		expect(pty(t, 0).resizes.at(-1)?.rows).toBeGreaterThan(12)
		expect(pty(t, 1).resizes.at(-1)?.rows).toBeLessThan(12)
	})
})

describe('closing panes', () => {
	it('lets the neighbour take the room and the focus', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'x')
		expect(pty(t, 1).kills).toEqual(['SIGHUP'])
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 74, rows: 28 })
		expect(t.host.roster.selected?.label).toBe('session 1')
		expect(t.host.roster.shownTab?.root.kind).toBe('leaf')
	})

	it('closes the tab with its last pane, and asks before closing the last tab of a workspace', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		expect(t.host.roster.workspaces[0]?.tabs).toHaveLength(2)
		nav(t, 'x')
		expect(t.host.roster.workspaces[0]?.tabs).toHaveLength(1)
		nav(t, 'x')
		expect(t.host.roster.workspaces[0]?.tabs).toHaveLength(1)
		expect((await rows(t)).join('\n')).toContain('Close workspace')
	})
})

describe('tabs', () => {
	it('adds a tab with c or the plus, and shows one chip per tab with the active one in the accent colour', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		let screen = await rows(t)
		expect(screen[0]?.slice(26, 46)).toMatch(/^\s+1\s+\s+2\s+\+/)
		expect((await t.cellAt(35, 0))?.bg).toBe(ACCENT)
		expect((await t.cellAt(26, 0))?.bg).not.toBe(ACCENT)
		expect(pty(t, 1).options).toMatchObject({ cols: 74, rows: 28 })
		// The plus is at columns 44 to 46.
		t.type(click(45, 0))
		expect(t.spawned).toHaveLength(3)
		screen = await rows(t)
		expect(screen[0]).toContain('3')
	})

	it('keeps the active tab in view when the tabs do not fit, with a cue for each side, and the cues move between tabs', async () => {
		const { t } = rig()
		t.host.start()
		for (let i = 0; i < 11; i++) {
			nav(t, 'c')
			t.type('\r')
		}
		expect(t.host.roster.workspaces[0]?.tabs).toHaveLength(12)
		let screen = await rows(t)
		// 74 columns do not hold twelve tabs: the newest is active, earlier ones are out of sight on the left.
		expect(screen[0]).toContain('12')
		expect(screen[0]?.slice(26)).toContain('‹')
		expect(screen[0]?.slice(26)).not.toContain('›')
		expect(screen[0]?.slice(26).trimEnd().endsWith('+')).toBe(true)
		// The cue is two cells at the left edge of the bar.
		t.type(click(26, 0))
		expect(t.host.roster.selected?.label).toBe('session 11')
		// Tab 12 is still in view, so there is nothing hidden on the right yet.
		screen = await rows(t)
		expect(screen[0]?.slice(26)).not.toContain('›')
		for (let i = 0; i < 6; i++) {
			t.type(click(26, 0))
			await rows(t)
		}
		expect(t.host.roster.selected?.label).toBe('session 5')
		screen = await rows(t)
		const at = (screen[0] ?? '').indexOf('›')
		expect(at).toBeGreaterThan(26)
		t.type(click(at, 0))
		expect(t.host.roster.selected?.label).toBe('session 6')
	})

	it('does nothing for a click on the rule under the tabs', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		t.type(click(30, 1))
		expect(t.host.roster.selected?.label).toBe('session 2')
		expect(t.spawned).toHaveLength(2)
	})

	it('moves with n, p and the number keys, and wraps', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		nav(t, 'c')
		t.type('\r')
		expect(t.host.roster.selected?.label).toBe('session 3')
		nav(t, 'n')
		expect(t.host.roster.selected?.label).toBe('session 1')
		nav(t, 'p')
		expect(t.host.roster.selected?.label).toBe('session 3')
		nav(t, '2')
		expect(t.host.roster.selected?.label).toBe('session 2')
		nav(t, '9')
		expect(t.host.roster.selected?.label).toBe('session 2')
	})

	it('shows each tab with its own panes, and refits them when the tab is shown again', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'c')
		t.type('\r')
		expect(pty(t, 2).options).toMatchObject({ cols: 74, rows: 28 })
		nav(t, 'p')
		expect(t.host.roster.selected?.label).toBe('session 2')
		t.type('x')
		expect(pty(t, 1).writes).toEqual(['x'])
	})

	it('closes a tab but never the last one, and the pane in a hidden tab keeps its mark', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'X')
		expect(t.host.roster.entries).toHaveLength(1)
		nav(t, 'c')
		t.type('\r')
		nav(t, 'p')
		nav(t, 'X')
		expect(t.host.roster.entries).toHaveLength(1)
		expect(pty(t, 0).kills).toEqual(['SIGHUP'])
		expect(t.host.roster.selected?.label).toBe('session 2')
	})

	it('marks a pane finished only while it is out of sight, not when it is in a split beside the focus', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'c')
		t.type('\r')
		const [first, , third] = t.host.roster.entries
		if (!first || !third) throw new Error('missing')
		// The first pane is in another tab now; one finishing there is unseen.
		first.reported = 'busy'
		t.host.roster.update(first)
		first.reported = 'idle'
		t.host.roster.update(first)
		expect(first.unseen).toBe(true)
		nav(t, 'p')
		expect(first.unseen).toBe(false)
		expect(third.unseen).toBe(false)
	})
})

describe('the mouse', () => {
	it('focuses the pane that is clicked, wherever its text is', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		t.type(click(30, 10))
		t.type('a')
		expect(pty(t, 0).writes).toEqual(['a'])
		t.type(click(80, 10))
		t.type('b')
		expect(pty(t, 1).writes).toEqual(['b'])
	})

	it('opens a tab that is clicked', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		t.type(click(30, 0))
		expect(t.host.roster.selected?.label).toBe('session 1')
		t.type(click(36, 0))
		expect(t.host.roster.selected?.label).toBe('session 2')
	})

	it('drags the border between two panes and refits both', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		// The border is the gap at column 63 and the edges on both sides of it. Grab 62 and pull it left by ten.
		t.type(click(62, 10))
		t.type(drag(57, 10))
		t.type(drag(52, 10))
		t.type(release(52, 10))
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 25, rows: 26 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 44, rows: 26 })
		// The press did not change focus; the second pane still has it.
		t.type('z')
		expect(pty(t, 1).writes).toEqual(['z'])
	})

	it('drags a top-over-bottom border', () => {
		const { t } = rig()
		t.host.start()
		nav(t, '-')
		// Rows 2 to 15 are the upper pane, row 16 the gap and rows 17 to 29 the lower.
		t.type(click(60, 15))
		t.type(drag(60, 20))
		t.type(release(60, 20))
		expect(pty(t, 0).resizes.at(-1)?.rows).toBe(17)
		expect(pty(t, 1).resizes.at(-1)?.rows).toBe(6)
	})

	it('scrolls the pane under the pointer, not the focused one', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\r\n')
		pty(t, 0).print(lines)
		await t.frame()
		t.type('\x1b[<64;30;6M')
		expect(t.host.roster.entries[0]?.scrollBack).toBe(3)
		expect(t.host.roster.entries[1]?.scrollBack).toBe(0)
		expect(t.host.roster.selected).toBe(t.host.roster.entries[1])
	})
})

describe('collapsing the sidebar and resizing the terminal', () => {
	it('refits every pane of the tab', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'b')
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 46, rows: 26 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 45, rows: 26 })
		t.output.columns = 60
		t.output.rows = 20
		for (const l of t.resizeListeners) l()
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 26, rows: 16 })
	})
})

class MemoryStore implements WorkspacesStore {
	saved: SavedLayout[] = []
	load() {
		return undefined
	}
	save(layout: SavedLayout) {
		this.saved.push(layout)
	}
}

describe('remembering tabs and trees', () => {
	it('writes the tree, the ratios, the zoom, the tab names and the focus, and restores them without starting anything but the focused tab', async () => {
		const store = new MemoryStore()
		const a = rig({ store })
		a.t.host.start()
		nav(a.t, 'v')
		nav(a.t, '-')
		nav(a.t, 'r')
		a.t.type('k')
		a.t.type('\x1b')
		nav(a.t, 'z')
		nav(a.t, 'T')
		a.t.type('build\r')
		nav(a.t, 'c')
		a.t.type('\r')
		nav(a.t, 'p')
		const saved = a.t.host.snapshot()
		expect(saved.version).toBe(3)
		const tab = saved.workspaces[0]?.tabs[0]
		expect(tab).toMatchObject({
			name: 'build',
			zoomed: true,
			focus: 2,
			tree: {
				split: 'side',
				ratio: 0.5,
				a: { session: { label: 'session 1' } },
				b: {
					split: 'stack',
					ratio: 0.45,
					a: { session: { label: 'session 2' } },
				},
			},
		})
		expect(saved.workspaces[0]?.tabs).toHaveLength(2)
		expect(saved.focus).toEqual({ workspace: 0 })

		const b = rig({
			restored: JSON.parse(JSON.stringify(saved)) as SavedLayout,
		})
		b.t.host.start()
		// Only the tab that had focus starts, all three of its panes.
		expect(b.t.spawned).toHaveLength(3)
		expect(b.t.host.roster.shownTab?.zoomed).toBe(true)
		expect(b.t.host.roster.shownTab?.name).toBe('build')
		expect(b.t.host.roster.selected?.label).toBe('session 3')
		expect(b.t.host.roster.workspaces[0]?.tabs).toHaveLength(2)
		expect(b.t.host.roster.workspaces[0]?.tabs[1]?.focus.child).toBeUndefined()
		expect(JSON.parse(JSON.stringify(b.t.host.snapshot()))).toEqual(
			JSON.parse(JSON.stringify(saved)),
		)
		// Unzoomed, the panes sit where they were.
		nav(b.t, 'z')
		expect(pty(b.t, 2).resizes.at(-1) ?? pty(b.t, 2).options).toMatchObject({
			cols: 34,
			rows: 13,
		})
	})
})

describe('moving a workspace', () => {
	it('puts a workspace at a place in the list and keeps the others in order', () => {
		const { t } = rig({
			listed: [
				{ cwd: '/work/a', name: 'a', sessions: 1 },
				{ cwd: '/work/b', name: 'b', sessions: 1 },
			],
		})
		t.host.start()
		const [first, second, third] = t.host.roster.workspaces
		expect(t.host.roster.moveWorkspace(third as never, 0)).toBe(true)
		expect(t.host.roster.workspaces.map((s) => s.name)).toEqual(['b', 'namzu', 'a'])
		expect(t.host.roster.moveWorkspace(third as never, 0)).toBe(false)
		expect(t.host.roster.moveWorkspace(first as never, 99)).toBe(true)
		expect(t.host.roster.workspaces.at(-1)).toBe(first)
		expect(second).toBeDefined()
	})
})

describe('the cursor over a session', () => {
	it('stays hidden even when the session shows its own', async () => {
		const { t } = rig()
		t.host.start()
		await t.frame()
		// The session prints some text and asks for its cursor, as a terminal layer in between may.
		pty(t, 0).print('\x1b[?25l> hello\r\nbelow the composer\x1b[?25h')
		await t.frame()
		const shown = t.written.join('')
		const hidden = shown.lastIndexOf('\x1b[?25l')
		const visible = shown.lastIndexOf('\x1b[?25h')
		expect(hidden, 'the host hid the cursor').toBeGreaterThanOrEqual(0)
		expect(hidden, 'and the last request it wrote was the hide').toBeGreaterThan(visible)
	})
})
