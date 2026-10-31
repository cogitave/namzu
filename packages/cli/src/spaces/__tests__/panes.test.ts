import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { rgb } from '../../terminal/host/cell.js'
import type { HostAccount, SessionRequest } from '../host.js'
import type { SavedLayout, SpacesStore } from '../store.js'
import { leaves } from '../tiling.js'
import { setup } from './support/harness.js'

const ACCENT = rgb(137, 180, 250)
const DIM = rgb(108, 112, 134)

function rig(extra: Parameters<typeof setup>[1] = {}, size = { columns: 100, rows: 30 }) {
	const requests: SessionRequest[] = []
	let n = 0
	const t = setup(size, {
		truecolor: true,
		newSlot: () => `slot-${++n}`,
		spec: (request) => {
			requests.push(request)
			return { file: 'node', args: ['bin.js'], cwd: request.cwd, env: {} }
		},
		...extra,
	})
	return { t, requests }
}

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

/** A hundred columns: the sidebar and its rule take 26, so the workspace area is 74 wide from column 26. */
describe('splitting', () => {
	it('splits side by side with v: each pane gets its inside, and the new one is a session with focus', () => {
		const { t, requests } = rig()
		t.host.start()
		expect(pty(t, 0).options).toMatchObject({ cols: 74, rows: 29 })
		nav(t, 'v')
		expect(t.spawned).toHaveLength(2)
		expect(requests[1]).toMatchObject({ cwd: '/work/namzu', first: false })
		expect(requests[1]?.resume).toBeUndefined()
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 35, rows: 27 })
		expect(pty(t, 1).options).toMatchObject({ cols: 35, rows: 27 })
		t.type('hi')
		expect(pty(t, 1).writes).toEqual(['hi'])
		expect(pty(t, 0).writes).toEqual([])
	})

	it('splits top over bottom with minus', () => {
		const { t } = rig()
		t.host.start()
		nav(t, '-')
		// 29 rows: the upper pane takes the odd one.
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 72, rows: 13 })
		expect(pty(t, 1).options).toMatchObject({ cols: 72, rows: 12 })
	})

	it('draws a square border on every pane, the focused one in the accent colour and the rest dim', async () => {
		const { t } = rig()
		t.host.start()
		expect((await rows(t))[1]?.[26]).not.toBe('┌')
		nav(t, 'v')
		nav(t, '-')
		const screen = await rows(t)
		// Left pane: columns 26 to 62. Right pane: columns 63 to 99, split at row 15.
		expect(screen[1]?.[26]).toBe('┌')
		expect(screen[1]?.[62]).toBe('┐')
		expect(screen[1]?.[63]).toBe('┌')
		expect(screen[29]?.[62]).toBe('┘')
		expect(screen[1]?.slice(27, 62)).toBe('─'.repeat(35))
		expect(screen[2]?.[26]).toBe('│')
		expect(screen[15]?.[63]).toBe('└')
		expect(screen[16]?.[63]).toBe('┌')
		// The focused pane is the bottom right one.
		expect((await t.cellAt(63, 16))?.fg).toBe(ACCENT)
		expect((await t.cellAt(99, 29))?.fg).toBe(ACCENT)
		expect((await t.cellAt(26, 1))?.fg).toBe(DIM)
		expect((await t.cellAt(63, 1))?.fg).toBe(DIM)
	})

	it('uses the nearest of the 16 colours when the terminal does not show true colour', async () => {
		const { t } = rig({ truecolor: false })
		t.host.start()
		nav(t, 'v')
		await t.frame()
		const focused = (await t.cellAt(63, 1))?.fg as number
		const other = (await t.cellAt(26, 1))?.fg as number
		expect(focused).toBeGreaterThanOrEqual(0)
		expect(focused).toBeLessThan(16)
		expect(other).toBeLessThan(16)
		expect(focused).not.toBe(other)
	})

	it('refuses a split that would leave a pane too small, and says so', async () => {
		const { t } = rig({}, { columns: 100, rows: 8 })
		t.host.start()
		nav(t, '-')
		expect(t.spawned).toHaveLength(1)
		expect((await rows(t)).join('\n')).toContain('not enough room')
		for (let i = 0; i < 6; i++) nav(t, 'v')
		// 74 columns hold six panes of 12, never more.
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
		expect(pty(t, 2).resizes.at(-1)).toEqual({ cols: 35, rows: 13 })
		expect(t.host.roster.selected?.label).toBe('session 3')
	})
})

describe('zoom', () => {
	it('fills the area with the focused pane and marks the tab with a Z, and brings the layout back', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'v')
		nav(t, 'z')
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 72, rows: 27 })
		let screen = await rows(t)
		expect(screen[0]).toContain('1 Z')
		expect(screen[1]?.[26]).toBe('┌')
		expect(screen[1]?.[99]).toBe('┐')
		nav(t, 'z')
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 35, rows: 27 })
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
		expect((await rows(t)).at(-1) ?? '').toContain('RESIZE')
		t.type('l')
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 39, rows: 27 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 31, rows: 27 })
		t.type('h')
		t.type('h')
		expect(pty(t, 1).resizes.at(-1)?.cols).toBe(39)
		t.type('\x1b')
		t.type('l')
		// Back with the session: the key is typed into it.
		expect(pty(t, 1).writes).toEqual(['l'])
		expect((await rows(t)).at(-1) ?? '').not.toContain('RESIZE')
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
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 74, rows: 29 })
		expect(t.host.roster.selected?.label).toBe('session 1')
		expect(t.host.roster.shownTab?.root.kind).toBe('leaf')
	})

	it('closes the tab with its last pane, and asks before closing the last tab of a space', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		expect(t.host.roster.spaces[0]?.tabs).toHaveLength(2)
		nav(t, 'x')
		expect(t.host.roster.spaces[0]?.tabs).toHaveLength(1)
		nav(t, 'x')
		expect(t.host.roster.spaces[0]?.tabs).toHaveLength(1)
		expect((await rows(t)).join('\n')).toContain('Close space')
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
		expect(pty(t, 1).options).toMatchObject({ cols: 74, rows: 29 })
		// The plus is at columns 44 to 46.
		t.type(click(45, 0))
		expect(t.spawned).toHaveLength(3)
		screen = await rows(t)
		expect(screen[0]).toContain('3')
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
		expect(pty(t, 2).options).toMatchObject({ cols: 74, rows: 29 })
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
		// The border is columns 62 and 63. Grab 62 and pull it left by ten.
		t.type(click(62, 10))
		t.type(drag(57, 10))
		t.type(drag(52, 10))
		t.type(release(52, 10))
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 25, rows: 27 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 45, rows: 27 })
		// The press did not change focus; the second pane still has it.
		t.type('z')
		expect(pty(t, 1).writes).toEqual(['z'])
	})

	it('drags a top-over-bottom border', () => {
		const { t } = rig()
		t.host.start()
		nav(t, '-')
		// Rows 1 to 14 are the upper pane and 15 to 28 the lower; the border is rows 14 and 15.
		t.type(click(60, 15))
		t.type(drag(60, 20))
		t.type(release(60, 20))
		expect(pty(t, 0).resizes.at(-1)?.rows).toBe(18)
		expect(pty(t, 1).resizes.at(-1)?.rows).toBe(7)
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
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 46, rows: 27 })
		expect(pty(t, 1).resizes.at(-1)).toEqual({ cols: 46, rows: 27 })
		t.output.columns = 60
		t.output.rows = 20
		for (const l of t.resizeListeners) l()
		expect(pty(t, 0).resizes.at(-1)).toEqual({ cols: 26, rows: 17 })
	})
})

class MemoryStore implements SpacesStore {
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
		expect(saved.version).toBe(2)
		const tab = saved.spaces[0]?.tabs[0]
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
		expect(saved.spaces[0]?.tabs).toHaveLength(2)
		expect(saved.focus).toEqual({ space: 0 })

		const b = rig({
			restored: JSON.parse(JSON.stringify(saved)) as SavedLayout,
		})
		b.t.host.start()
		// Only the tab that had focus starts, all three of its panes.
		expect(b.t.spawned).toHaveLength(3)
		expect(b.t.host.roster.shownTab?.zoomed).toBe(true)
		expect(b.t.host.roster.shownTab?.name).toBe('build')
		expect(b.t.host.roster.selected?.label).toBe('session 3')
		expect(b.t.host.roster.spaces[0]?.tabs).toHaveLength(2)
		expect(b.t.host.roster.spaces[0]?.tabs[1]?.focus.child).toBeUndefined()
		expect(JSON.parse(JSON.stringify(b.t.host.snapshot()))).toEqual(
			JSON.parse(JSON.stringify(saved)),
		)
		// Unzoomed, the panes sit where they were.
		nav(b.t, 'z')
		expect(pty(b.t, 2).resizes.at(-1) ?? pty(b.t, 2).options).toMatchObject({
			cols: 35,
			rows: 14,
		})
	})
})
