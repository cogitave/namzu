import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import type { HostAccount } from '../host.js'
import { BINDINGS, keyName } from '../keymap.js'
import { layoutModal } from '../overlay.js'
import { setup } from './support/harness.js'

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`
const rightPress = (x: number, y: number) => `\x1b[<2;${x + 1};${y + 1}M`
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`
const ESC = '\x1b'

const ACCOUNTS: HostAccount[] = [
	{ id: 'openai:free-a', label: 'free-a', provider: 'openai' },
	{ id: 'openai:free-b', label: 'free-b', provider: 'openai' },
]

type Rig = ReturnType<typeof setup>

const nav = (t: Rig, keys: string) => {
	t.type('\x02')
	t.type(keys)
}

async function text(t: Rig): Promise<string[]> {
	await t.frame()
	return t.screen()
}

async function shows(t: Rig, needle: string): Promise<boolean> {
	return (await text(t)).join('\n').includes(needle)
}

/** Where the first line holding `needle` has it, as a screen cell. */
async function find(t: Rig, needle: string): Promise<{ x: number; y: number }> {
	const lines = await text(t)
	const y = lines.findIndex((l) => l.includes(needle))
	expect(y, `"${needle}" on screen`).toBeGreaterThanOrEqual(0)
	return { x: (lines[y] as string).indexOf(needle), y }
}

async function click(t: Rig, needle: string): Promise<void> {
	const at = await find(t, needle)
	t.type(press(at.x + 1, at.y))
	t.type(release(at.x + 1, at.y))
}

function start(extra: Parameters<typeof setup>[1] = {}, size = { columns: 100, rows: 30 }): Rig {
	const t = setup(size, extra)
	t.host.start()
	return t
}

describe('name and question modals', () => {
	it('asks for a new space in a centred modal with the focused folder filled in', async () => {
		const t = start()
		nav(t, 'N')
		const lines = await text(t)
		expect(lines.join('\n')).toContain('new space')
		expect(lines.join('\n')).toContain('/work/namzu')
		expect(lines.join('\n')).toContain('↲ open')
		expect(lines.join('\n')).toContain('esc cancel')
		// Centred on the screen.
		const title = await find(t, 'new space')
		const box = lines.findIndex((l) => l.includes('┌'))
		expect(box).toBeGreaterThan(5)
		expect(title.x).toBeGreaterThan(20)
		// Everything behind it is dimmed.
		const behind = await t.cellAt(2, 2)
		expect((behind?.attrs ?? 0) & 2).toBe(2)
		t.type('\x03')
		t.type('/work/site')
		t.type('\r')
		expect(t.host.roster.spaces.map((s) => s.name)).toEqual(['namzu', 'site'])
		expect(await shows(t, 'new space')).toBe(false)
	})

	it('says so when the folder is missing and keeps the modal open', async () => {
		const t = start()
		nav(t, 'N')
		t.type('\x03')
		t.type('/nowhere')
		t.type('\r')
		expect(await shows(t, 'No such folder.')).toBe(true)
		expect(t.host.roster.spaces).toHaveLength(1)
	})

	it('renames a space and a tab with the name filled in, saving from the button or enter', async () => {
		const t = start()
		nav(t, 'W')
		expect(await shows(t, 'rename space')).toBe(true)
		t.type('\x7f'.repeat('namzu'.length))
		t.type('core')
		await click(t, '↲ save')
		expect(t.host.roster.spaces[0]?.name).toBe('core')
		nav(t, 'c')
		expect(await shows(t, 'new tab')).toBe(true)
		t.type('build')
		t.type('\r')
		nav(t, 'T')
		expect(await shows(t, 'rename tab')).toBe(true)
		expect(await shows(t, 'build▏')).toBe(false)
		expect((await text(t)).join('\n')).toContain('build')
		t.type('\x03')
		await click(t, '^c clear')
		await click(t, 'esc cancel')
		expect(t.host.roster.shownTab?.name).toBe('build')
		nav(t, 'P')
		expect(await shows(t, 'rename pane')).toBe(true)
		expect(await shows(t, 'session 2')).toBe(true)
	})

	it('closes on escape and on a click outside, changing nothing', async () => {
		const t = start()
		nav(t, 'W')
		t.type('x')
		t.type(ESC)
		expect(await shows(t, 'rename space')).toBe(false)
		nav(t, 'W')
		t.type('x')
		t.type(press(60, 2))
		expect(await shows(t, 'rename space')).toBe(false)
		expect(t.host.roster.spaces[0]?.name).toBe('namzu')
		// The click did not reach the pane or the sidebar under it.
		expect((t.spawned[0] as FakePty).writes).toEqual([])
	})

	it('asks before closing a space with buttons, and a click on cancel keeps it', async () => {
		const t = start()
		nav(t, 'D')
		const lines = (await text(t)).join('\n')
		expect(lines).toContain('Close space?')
		expect(lines).toContain('namzu — 1 pane')
		expect(lines).toContain('↲ confirm')
		await click(t, 'esc cancel')
		expect(await shows(t, 'Close space?')).toBe(false)
		expect((t.spawned[0] as FakePty).kills).toEqual([])
		nav(t, 'D')
		await click(t, '↲ confirm')
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
	})

	it('confirms with enter as well as y, and any other key keeps the space', async () => {
		const t = start()
		nav(t, 'D')
		t.type('x')
		expect((t.spawned[0] as FakePty).kills).toEqual([])
		nav(t, 'D')
		t.type('\r')
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
	})

	it('draws the account picker as a modal and takes a click on a row', async () => {
		const t = start({ accounts: () => ACCOUNTS })
		nav(t, 'c')
		const lines = (await text(t)).join('\n')
		expect(lines).toContain('Start a session in namzu on')
		expect(lines).toContain('free-b')
		await click(t, 'free-b')
		expect(t.spawned).toHaveLength(2)
		expect(await shows(t, 'new tab')).toBe(true)
	})
})

describe('the context menu', () => {
	it('opens on a right-click of a space and renames it', async () => {
		const t = start()
		t.type(rightPress(5, 2))
		const lines = (await text(t)).join('\n')
		expect(lines).toContain('Rename')
		expect(lines).toContain('New tab')
		expect(lines).toContain('Close')
		await click(t, 'Rename')
		expect(await shows(t, 'rename space')).toBe(true)
	})

	it('offers rename and close for a tab, and closing the only tab asks to close the space', async () => {
		const t = start()
		t.type(rightPress(28, 0))
		const lines = (await text(t)).join('\n')
		expect(lines).toContain('Rename')
		expect(lines).not.toContain('Split right')
		await click(t, 'Close')
		expect(await shows(t, 'Close space?')).toBe(true)
	})

	it('offers split, zoom and close for a pane and runs the choice', async () => {
		const t = start()
		t.type(rightPress(60, 10))
		expect((await text(t)).join('\n')).toContain('Split right')
		await click(t, 'Split right')
		expect(t.spawned).toHaveLength(2)
		expect(t.host.roster.entries).toHaveLength(2)
	})

	it('moves with the arrows, runs on enter and closes on escape or a click outside', async () => {
		const t = start()
		t.type(rightPress(5, 2))
		t.type('j')
		t.type('\r')
		expect(await shows(t, 'new tab')).toBe(true)
		t.type(ESC)
		t.type(rightPress(5, 2))
		t.type(ESC)
		expect(await shows(t, 'New tab')).toBe(false)
		t.type(rightPress(5, 2))
		t.type(press(60, 20))
		expect(await shows(t, 'New tab')).toBe(false)
		expect(t.host.roster.entries).toHaveLength(2)
	})
})

describe('reordering spaces by dragging', () => {
	const listed = [
		{ cwd: '/work/site', name: 'site', sessions: 1 },
		{ cwd: '/work/docs', name: 'docs', sessions: 1 },
	]

	it('moves a space to where it is dropped and remembers the order', async () => {
		const t = start({ listed })
		await t.frame()
		expect(t.host.roster.spaces.map((s) => s.name)).toEqual(['namzu', 'site', 'docs'])
		t.type(press(4, 6))
		t.type(drag(4, 4))
		t.type(drag(4, 2))
		await t.frame()
		// The drop line shows where it would land: under the header's gap above the first space.
		expect((await t.cellAt(5, 1))?.attrs ?? 0).toSatisfy((a: number) => (a & 8) === 8)
		t.type(release(4, 2))
		expect(t.host.roster.spaces.map((s) => s.name)).toEqual(['docs', 'namzu', 'site'])
		expect(t.host.snapshot().spaces.map((s) => s.name)).toEqual(['docs', 'namzu', 'site'])
	})

	it('moves a space to the end when it is dropped on the blank area under the last one', async () => {
		const t = start({ listed })
		await t.frame()
		t.type(press(4, 2))
		t.type(drag(4, 4))
		t.type(drag(4, 10))
		t.type(release(4, 10))
		expect(t.host.roster.spaces.map((s) => s.name)).toEqual(['site', 'docs', 'namzu'])
	})

	it('leaves the order alone for a plain click', async () => {
		const t = start({ listed })
		t.type(press(4, 4))
		t.type(release(4, 4))
		expect(t.host.roster.spaces.map((s) => s.name)).toEqual(['namzu', 'site', 'docs'])
		expect(t.host.roster.selected?.label).toBe('session 1')
		expect(t.host.roster.spaceOf(t.host.roster.selected as never).name).toBe('site')
	})
})

describe('the go-to overlay', () => {
	const listed = [{ cwd: '/work/site', name: 'site', sessions: 2 }]

	it('lists every space, tab and pane with a filter, and enter focuses the choice', async () => {
		const t = start({ listed })
		nav(t, 'g')
		let lines = (await text(t)).join('\n')
		expect(lines).toContain('go to')
		expect(lines).toContain('namzu')
		expect(lines).toContain('tab 2')
		expect(lines).toContain('session 2')
		t.type('site')
		lines = (await text(t)).join('\n')
		expect(lines).not.toContain('nothing matches')
		t.type('\r')
		expect(await shows(t, 'go to')).toBe(false)
		expect(t.host.roster.spaceOf(t.host.roster.selected as never).name).toBe('site')
	})

	it('says when nothing matches, moves with the arrows and clears with control-c', async () => {
		const t = start({ listed })
		nav(t, 'g')
		t.type('zzz')
		expect(await shows(t, 'nothing matches')).toBe(true)
		t.type('\x03')
		expect(await shows(t, 'nothing matches')).toBe(false)
		t.type('2')
		t.type('\x1b[B')
		t.type('\r')
		expect(t.host.roster.spaceOf(t.host.roster.selected as never).name).toBe('site')
	})

	it('focuses a row that is clicked, and closes on escape or a click outside', async () => {
		const t = start({ listed })
		nav(t, 'g')
		const lines = await text(t)
		const title = lines.findIndex((l) => l.includes('go to'))
		const row = lines.findIndex((l, i) => i > title && l.includes('site'))
		t.type(press(40, row))
		expect(await shows(t, 'go to')).toBe(false)
		expect(t.host.roster.spaceOf(t.host.roster.selected as never).name).toBe('site')
		nav(t, 'g')
		t.type(ESC)
		expect(await shows(t, 'go to')).toBe(false)
		nav(t, 'g')
		t.type(press(1, 28))
		expect(await shows(t, 'go to')).toBe(false)
	})
})

describe('the keybinds overlay', () => {
	it('prints every binding of the key map', async () => {
		const t = start({}, { columns: 100, rows: 60 })
		nav(t, '?')
		const lines = (await text(t)).join('\n')
		expect(lines).toContain('keybinds')
		for (const b of BINDINGS) {
			expect(lines, b.action).toContain(b.label)
			if (b.keys.length === 1) expect(lines, b.action).toContain(keyName(b.keys[0] as string))
		}
		expect(lines).toContain('ctrl+b then a key')
		t.type(ESC)
		expect(await shows(t, 'ctrl+b then a key')).toBe(false)
	})

	it('scrolls on a short screen and closes on a click outside', async () => {
		const t = start({}, { columns: 100, rows: 20 })
		nav(t, '?')
		expect(await shows(t, 'zoom pane')).toBe(false)
		for (let i = 0; i < 40; i++) t.type('j')
		expect(await shows(t, 'rename pane')).toBe(true)
		t.type(press(0, 0))
		expect(await shows(t, 'rename pane')).toBe(false)
	})

	it('runs every binding of the key map', async () => {
		const t = start({}, { columns: 100, rows: 60 })
		for (const b of BINDINGS) {
			// Keys that open a mode or an overlay are left by escape; the rest do their work.
			nav(
				t,
				b.keys[0] === 'tab' ? '\t' : b.keys[0] === 'backtab' ? '\x1b[Z' : (b.keys[0] as string),
			)
			t.type(ESC)
			expect(t.host.roster.selected, b.action).toBeDefined()
		}
	})
})

describe('the menu overlay', () => {
	async function openMenu(t: Rig): Promise<void> {
		const row = (await text(t)).findIndex((l) => /^ new\s+menu/u.test(l))
		t.type(press(22, row))
	}

	it('lists accounts, add account, sidebar, keybinds and quit', async () => {
		const t = start({ accounts: () => ACCOUNTS })
		await openMenu(t)
		const lines = (await text(t)).join('\n')
		for (const item of ['accounts', 'add account', 'sidebar', 'keybinds', 'quit'])
			expect(lines).toContain(item)
	})

	it('shows the accounts, toggles the sidebar and opens the keybinds', async () => {
		const t = start({ accounts: () => ACCOUNTS })
		await openMenu(t)
		await click(t, 'accounts')
		let lines = (await text(t)).join('\n')
		expect(lines).toContain('free-a')
		expect(lines).toContain('/auth')
		t.type(ESC)
		await openMenu(t)
		await click(t, 'keybinds')
		expect(await shows(t, 'ctrl+b then a key')).toBe(true)
		t.type(ESC)
		await openMenu(t)
		await click(t, 'sidebar')
		expect(t.host.snapshot().sidebar?.collapsed).toBe(true)
		lines = (await text(t)).join('\n')
		expect(lines).not.toContain('agents')
	})

	it('starts a session for adding an account and says where to type the command', async () => {
		const t = start()
		await openMenu(t)
		await click(t, 'add account')
		expect(t.spawned).toHaveLength(2)
		expect(await shows(t, 'Type /auth in this session to add an account.')).toBe(true)
	})

	it('opens from the s key as well', async () => {
		const t = start()
		nav(t, 's')
		expect(await shows(t, 'add account')).toBe(true)
		t.type(press(60, 20))
		expect(await shows(t, 'add account')).toBe(false)
	})
})

describe('modals on a very small terminal', () => {
	it('keeps every drawn button inside the box and drops the optional one first', () => {
		const spec = {
			title: 'new space',
			input: { value: '' },
			buttons: [
				{ label: '↲ open', action: 'confirm' as const, primary: true },
				{ label: '^c clear', action: 'clear' as const },
				{ label: 'esc cancel', action: 'cancel' as const },
			],
		}
		const layout = layoutModal({ cols: 30, rows: 8 }, spec)
		expect(layout.buttons.map((b) => b.action)).toEqual(['confirm', 'cancel'])
		for (const b of layout.buttons) {
			expect(b.rect.x).toBeGreaterThanOrEqual(layout.rect.x)
			expect(b.rect.x + b.rect.width).toBeLessThanOrEqual(layout.rect.x + layout.rect.width)
		}
		expect(layoutModal({ cols: 100, rows: 30 }, spec).buttons).toHaveLength(3)
	})
})
