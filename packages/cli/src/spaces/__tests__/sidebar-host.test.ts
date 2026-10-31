import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import type { GitStatus } from '../git.js'
import { GitCache } from '../git.js'
import { agentList, geometry } from '../sidebar.js'
import { type SavedLayout, type SpacesStore, parseLayout } from '../store.js'
import { setup } from './support/harness.js'

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`

class MemoryStore implements SpacesStore {
	saved: SavedLayout[] = []
	load() {
		return undefined
	}
	save(layout: SavedLayout) {
		this.saved.push(layout)
	}
}

async function text(t: ReturnType<typeof setup>): Promise<string[]> {
	await t.frame()
	return t.screen()
}

describe('git lookups', () => {
	it('start only after the first frame and show the branch with its arrows', async () => {
		const asked: string[] = []
		const answers: Record<string, GitStatus> = {
			'/work/namzu': { branch: 'main', ahead: 1, behind: 2 },
		}
		const t = setup(
			{ columns: 100, rows: 30 },
			{
				git: (cwd) => {
					asked.push(cwd)
					return Promise.resolve(answers[cwd])
				},
			},
		)
		t.host.start()
		expect(asked).toEqual([])
		await t.frame()
		expect(asked).toEqual(['/work/namzu'])
		await Promise.resolve()
		await Promise.resolve()
		const lines = await text(t)
		expect(lines.some((l) => l.startsWith('   main ↑1 ↓2'))).toBe(true)
	})

	it('are repeated on a timer, never twice at once, and a failure shows nothing', async () => {
		let calls = 0
		let release_: (() => void) | undefined
		const cache = new GitCache(
			() => {
				calls++
				return new Promise<GitStatus | undefined>((_, reject) => {
					release_ = () => reject(new Error('no git'))
				})
			},
			() => undefined,
			() => 0,
		)
		cache.refresh('/x')
		cache.refresh('/x')
		expect(calls).toBe(1)
		release_?.()
		await Promise.resolve()
		await Promise.resolve()
		expect(cache.get('/x')).toBeUndefined()
		cache.refresh('/x')
		expect(calls).toBe(2)
	})

	it('are not repeated for a space shown again within a moment', () => {
		let now = 0
		let calls = 0
		const cache = new GitCache(
			() => {
				calls++
				return Promise.resolve(undefined)
			},
			() => undefined,
			() => now,
		)
		cache.refresh('/x', 1500)
		return Promise.resolve().then(async () => {
			await Promise.resolve()
			now = 500
			cache.refresh('/x', 1500)
			expect(calls).toBe(1)
			now = 2000
			cache.refresh('/x', 1500)
			expect(calls).toBe(2)
		})
	})
})

describe('the sidebar in the host', () => {
	it('"new" opens a space in the focused pane\'s folder at once', async () => {
		const t = setup()
		t.host.start()
		await t.frame()
		const row = (await t.screen()).findIndex((l) => /^ new\s+menu/u.test(l))
		t.type(press(1, row))
		expect(t.host.roster.spaces).toHaveLength(2)
		expect(t.host.roster.spaces[1]?.cwd).toBe('/work/namzu')
		expect(t.spawned).toHaveLength(2)
		expect((t.spawned[1] as FakePty).options.cwd).toBe('/work/namzu')
	})

	it('collapses to the rail with the » target and with the prefix key, and remembers it', async () => {
		const store = new MemoryStore()
		const t = setup({ columns: 100, rows: 30 }, { store })
		t.host.start()
		let lines = await text(t)
		t.type(press(24, 29))
		lines = await text(t)
		expect(lines[0]?.startsWith('1 ')).toBe(true)
		expect(lines[29]).toContain('»')
		expect(t.host.snapshot().sidebar).toEqual({ collapsed: true })
		t.type(press(1, 29))
		lines = await text(t)
		expect(lines[0]).toContain('spaces')
		t.type('\x02')
		t.type('b')
		expect((await text(t))[0]?.startsWith('1 ')).toBe(true)
	})

	it('resizes by dragging the edge and resets on a double click', async () => {
		let now = 1000
		const store = new MemoryStore()
		const t = setup({ columns: 100, rows: 30 }, { store, now: () => now })
		t.host.start()
		// The edge is column 25. Drag it to column 31: the sidebar becomes 32 wide.
		t.type(press(25, 10))
		t.type(drag(31, 10))
		t.type(release(31, 10))
		expect(t.host.snapshot().sidebar?.width).toBe(32)
		expect((t.spawned[0] as FakePty).resizes.at(-1)?.cols).toBe(68)
		// Dragging far left stops at the narrowest.
		now = 5000
		t.type(press(31, 10))
		t.type(drag(3, 10))
		t.type(release(3, 10))
		expect(t.host.snapshot().sidebar?.width).toBe(18)
		// Two presses close together reset it.
		now = 9000
		t.type(press(17, 10))
		t.type(release(17, 10))
		now = 9200
		t.type(press(17, 10))
		expect(t.host.snapshot().sidebar?.width).toBeUndefined()
		expect((t.spawned[0] as FakePty).resizes.at(-1)?.cols).toBe(74)
	})

	it('moves the rule between the sections by dragging it', async () => {
		const t = setup({ columns: 100, rows: 30 })
		t.host.start()
		const lines = await text(t)
		const rule = lines.findIndex((l) => l.startsWith('─────'))
		t.type(press(5, rule))
		t.type(drag(5, 20))
		t.type(release(5, 20))
		expect(t.host.snapshot().sidebar?.split).toBeCloseTo(20 / 30, 2)
	})

	it('switches the agents order from its header and remembers it', async () => {
		const t = setup()
		t.host.start()
		let lines = await text(t)
		const row = lines.findIndex((l) => / agents +grouped/u.test(l))
		t.type(press(22, row))
		lines = await text(t)
		expect(lines[row]).toContain('priority')
		expect(t.host.snapshot().sidebar?.order).toBe('priority')
	})

	it('opens the menu popup from "menu", moves in it and closes it with escape', async () => {
		const t = setup()
		t.host.start()
		await t.frame()
		const row = (await t.screen()).findIndex((l) => /^ new\s+menu/u.test(l))
		t.type(press(22, row))
		let lines = await text(t)
		expect(lines.join('\n')).toContain('keybinds')
		expect(lines.join('\n')).toContain('quit')
		t.type('j')
		t.type('\r')
		lines = await text(t)
		expect(lines.join('\n')).toContain('Quit all sessions?')
		t.type('n')
		t.type(press(22, row))
		t.type('\x1b')
		expect((await text(t)).join('\n')).not.toContain('keybinds')
		expect((t.spawned[0] as FakePty).writes).toEqual([])
	})

	it('restores the sidebar choices', async () => {
		const restored = parseLayout({
			version: 2,
			spaces: [
				{
					name: 'namzu',
					cwd: '/work/namzu',
					tabs: [{ tree: { session: { label: 'session 1' } } }],
				},
			],
			sidebar: { collapsed: true, width: 99, split: 0.3, order: 'priority' },
		}) as SavedLayout
		expect(restored.sidebar).toEqual({
			collapsed: true,
			width: 36,
			split: 0.3,
			order: 'priority',
		})
		const t = setup({ columns: 100, rows: 30 }, { restored })
		t.host.start()
		expect((await text(t))[0]?.startsWith('1 ')).toBe(true)
		expect(t.host.snapshot().sidebar).toEqual({
			collapsed: true,
			width: 36,
			split: 0.3,
			order: 'priority',
		})
	})

	it('shows PREFIX hints as keys and what they do, and none in the sidebar', async () => {
		const t = setup()
		t.host.start()
		t.type('\x02')
		const lines = await text(t)
		expect(lines.at(-1)).toContain(
			'PREFIX  esc cancel  ctrl+b send prefix  w space nav  ? keybinds',
		)
		const bar = await t.cellAt(30, 29)
		expect(bar?.bg).toBeDefined()
		expect(lines.slice(0, 29).join('\n')).not.toContain('ctrl+b to navigate')
	})

	it('a click on an agent of another space and tab shows that space, tab and pane', async () => {
		const t = setup({ columns: 100, rows: 30 })
		t.host.start()
		await t.frame()
		const row = (await t.screen()).findIndex((l) => /^ new\s+menu/u.test(l))
		t.type(press(1, row))
		const { roster } = t.host
		const second = roster.spaces[1]
		expect(second).toBeDefined()
		if (!second) return
		const extra = roster.addSession(second, 'late')
		roster.addTab(second, extra)
		const first = roster.spaces[0]?.tabs[0]?.focus
		if (first) roster.select(first)
		await t.frame()
		const geo = geometry(30, 0, 0.5, false)
		const list = agentList(roster, 'grouped')
		const at = list.indexOf(extra)
		expect(at).toBeGreaterThan(0)
		t.type(press(5, geo.agentTop + at * geo.spaceStep))
		expect(roster.selected).toBe(extra)
		expect(roster.spaceOf(extra)).toBe(second)
		expect(second.activeTab).toBe(roster.tabOf(extra))
	})

	it('draws the 16-colour sidebar with a tint on the shown space', async () => {
		const t = setup({ columns: 100, rows: 30 }, { truecolor: false })
		t.host.start()
		await t.frame()
		const cell = await t.cellAt(5, 2)
		expect(cell?.bg).toBeDefined()
		expect((await t.screen())[2]).toContain('namzu')
	})
})
