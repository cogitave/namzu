import type { PeerRecord } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { dotStyle } from '../sidebar.js'
import { FakePeers } from './support/fake-peers.js'
import { setup } from './support/harness.js'

function rig(extra = {}, size = { columns: 100, rows: 30 }) {
	const peers = new FakePeers()
	let n = 0
	const t = setup(size, { peers, newSlot: () => `slot-${++n}`, ...extra })
	return { t, peers }
}

const nav = (t: ReturnType<typeof setup>, keys: string) => {
	t.type('\x02')
	t.type(keys)
}

async function lines(t: ReturnType<typeof setup>): Promise<string> {
	await t.frame()
	return (await t.screen()).join('\n')
}

describe('spaces and sessions', () => {
	it('passes each session its slot, and only the first the command options', () => {
		const { t } = rig()
		t.host.start()
		expect((t.spawned[0] as FakePty).options.env).toEqual({ A: '1' })
		nav(t, 'c')
		t.type('\r')
		expect(t.spawned).toHaveLength(2)
		expect((t.spawned[1] as FakePty).options.cwd).toBe('/work/namzu')
		// New sessions take the keyboard.
		t.type('hi')
		expect((t.spawned[1] as FakePty).writes).toEqual(['hi'])
		expect((t.spawned[0] as FakePty).writes).toEqual([])
	})

	it('opens a new space from a typed folder and rejects one that is missing', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'N')
		t.type('/gone')
		t.type('\r')
		expect(await lines(t)).toContain('No such folder.')
		expect(t.spawned).toHaveLength(1)
		t.type('\x7f\x7f\x7f\x7f\x7f')
		t.type('site')
		t.type('\r')
		expect(t.spawned).toHaveLength(2)
		expect((t.spawned[1] as FakePty).options.cwd).toBe('/work/namzu/site')
		const text = await lines(t)
		expect(text).toContain('1 namzu')
		expect(text).toContain('2 site')
		expect(text).toContain('sessions in site')
		// A folder that is already a space only shows it.
		nav(t, 'N')
		t.type('/work/namzu\r')
		expect(t.spawned).toHaveLength(2)
		expect(await lines(t)).toContain('sessions in namzu')
	})

	it('cancels a prompt with escape and keeps the typed keys out of the session', () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'N')
		t.type('abc')
		t.type('\x1b')
		expect((t.spawned[0] as FakePty).writes).toEqual([])
		// The keyboard is the session's again.
		t.type('x')
		expect((t.spawned[0] as FakePty).writes).toEqual(['x'])
	})

	it('renames a pane, a tab and a space', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'P')
		t.type('\x7f'.repeat('session 1'.length))
		t.type('fix test\r')
		nav(t, 'W')
		t.type('\x7f'.repeat('namzu'.length))
		t.type('core\r')
		nav(t, 'T')
		t.type('build\r')
		const text = await lines(t)
		expect(text).toContain('fix test')
		expect(text).toContain('1 core')
		expect(text.split('\n')[0]).toContain('build')
		// An empty name puts the number back.
		nav(t, 'T')
		t.type('\x7f'.repeat('build'.length))
		t.type('\r')
		expect((await lines(t)).split('\n')[0]).not.toContain('build')
	})

	it('closes a pane without asking, and a space with all its panes after asking', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		nav(t, 'x')
		expect((t.spawned[1] as FakePty).kills).toEqual(['SIGHUP'])
		expect(t.host.roster.entries).toHaveLength(1)
		expect(t.host.roster.selected?.label).toBe('session 1')
		nav(t, 'c')
		t.type('\r')
		nav(t, 'D')
		expect(await lines(t)).toContain('Close space "namzu" and')
		t.type('n')
		expect(t.host.roster.entries).toHaveLength(2)
	})

	it('asks before the last pane of a space closes the space, and quits when it was the last space', async () => {
		const { t } = rig()
		t.host.start()
		nav(t, 'x')
		expect(await lines(t)).toContain('Close space "namzu"')
		t.type('y')
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
		;(t.spawned[0] as FakePty).end(0, 1)
		await expect(t.host.done).resolves.toBe(0)
	})

	it('starts a listed session only when its tab is first opened', async () => {
		const { t } = rig({
			listed: [{ cwd: '/work/site', name: 'site', sessions: 2 }],
		})
		t.host.start()
		expect(t.spawned).toHaveLength(1)
		nav(t, 'w')
		t.type('j')
		const text = await lines(t)
		expect(text).toContain('not started')
		expect(text).toContain('has not started yet')
		expect(t.spawned).toHaveLength(1)
		t.type('\r')
		expect(t.spawned).toHaveLength(2)
		expect((t.spawned[1] as FakePty).options.cwd).toBe('/work/site')
		// The second listed session is in its own tab and is still waiting.
		expect(t.host.roster.entries[2]?.child).toBeUndefined()
	})

	it('moves between spaces in navigate mode and between tabs with n, p and the number keys', () => {
		const { t } = rig({
			listed: [{ cwd: '/work/site', name: 'site', sessions: 2 }],
		})
		t.host.start()
		nav(t, 'w')
		t.type('j')
		expect(t.host.roster.selected?.spaceId).toBe('space-2')
		t.type('k')
		expect(t.host.roster.selected?.spaceId).toBe('space-1')
		t.type('j')
		t.type('\r')
		nav(t, 'n')
		expect(t.host.roster.selected?.label).toBe('session 2')
		nav(t, 'p')
		expect(t.host.roster.selected?.label).toBe('session 1')
		nav(t, '2')
		expect(t.host.roster.selected?.label).toBe('session 2')
	})
})

describe('status feed', () => {
	it('shows a working session and its space as working, from the live record alone', async () => {
		const { t, peers } = rig()
		t.host.start()
		expect(await lines(t)).toContain('starting')
		peers.publish('slot-1', 'busy')
		const text = await lines(t)
		expect(text).toContain('working')
		const space = t.host.roster.spaces[0]
		expect(t.host.roster.spaceDot(space as never)).toBe('working')
		const cell = await t.cellAt(24, 1)
		expect(cell?.ch).toBe('●')
		expect(cell?.fg).toBe(dotStyle('working').fg)
	})

	it('turns a space red when a background session needs approval', async () => {
		const { t, peers } = rig({ listed: [] })
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		peers.publish('slot-1', 'idle')
		peers.publish('slot-2', 'idle')
		// The second session is shown; the first asks for approval in the background.
		peers.publish('slot-1', 'awaiting-permission')
		const text = await lines(t)
		expect(text).toContain('needs approval')
		expect(t.host.roster.spaceDot(t.host.roster.spaces[0] as never)).toBe('blocked')
		const row = (await t.screen()).findIndex((l) => l.includes('1 namzu'))
		const cell = await t.cellAt(24, row)
		expect(cell?.fg).toBe(dotStyle('blocked').fg)
	})

	it('marks a session that finished while another was shown, and clears it when it is viewed', async () => {
		const { t, peers } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		peers.publish('slot-1', 'busy')
		peers.publish('slot-2', 'idle')
		expect(t.host.roster.entries[0]?.unseen).toBe(false)
		peers.publish('slot-1', 'idle')
		const first = t.host.roster.entries[0]
		expect(first?.unseen).toBe(true)
		const text = await lines(t)
		expect(text).toContain('finished')
		expect(t.host.roster.spaceDot(t.host.roster.spaces[0] as never)).toBe('done')
		// Looking at it clears the mark.
		nav(t, 'p')
		expect(first?.unseen).toBe(false)
		expect(t.host.roster.spaceDot(t.host.roster.spaces[0] as never)).toBe('idle')
	})

	it('does not mark the session that finishes while it is the one shown', () => {
		const { t, peers } = rig()
		t.host.start()
		peers.publish('slot-1', 'busy')
		peers.publish('slot-1', 'idle')
		expect(t.host.roster.entries[0]?.unseen).toBe(false)
	})

	it('ranks blocked over finished over working over idle in a space', () => {
		const { t, peers } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		nav(t, 'c')
		t.type('\r')
		peers.publish('slot-1', 'busy')
		peers.publish('slot-2', 'busy')
		peers.publish('slot-3', 'idle')
		const space = t.host.roster.spaces[0] as never
		expect(t.host.roster.spaceDot(space)).toBe('working')
		peers.publish('slot-1', 'idle')
		expect(t.host.roster.spaceDot(space)).toBe('done')
		peers.publish('slot-2', 'awaiting-permission')
		expect(t.host.roster.spaceDot(space)).toBe('blocked')
	})

	it('catches a change that was never written by asking the terminal', async () => {
		const { t, peers } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		peers.publish('slot-1', 'busy')
		peers.publish('slot-2', 'idle')
		// The record still says busy; the terminal itself says it is done.
		peers.answers.set('id-slot-1', 'idle')
		t.tick(2500)
		await t.host.reconcile()
		expect(t.host.roster.entries[0]?.reported).toBe('idle')
		expect(t.host.roster.entries[0]?.unseen).toBe(true)
	})

	it('re-reads the records on the poll timer when the watcher says nothing', () => {
		const { t, peers } = rig()
		peers.watchers.clear()
		t.host.start()
		peers.watch = () => () => undefined
		peers.records_ = []
		peers.publish('slot-1', 'busy')
		peers.watchers.clear()
		t.tick(1000)
		expect(t.host.roster.entries[0]?.reported).toBe('busy')
	})

	it('shows a session as ended when its process is gone, whatever its last record said', async () => {
		const { t, peers } = rig()
		t.host.start()
		peers.publish('slot-1', 'busy')
		;(t.spawned[0] as FakePty).end(1)
		expect(t.host.roster.entries[0]?.dot()).toBe('none')
		expect(await lines(t)).toContain('stopped')
	})

	it('shows the account only when it is not the default', async () => {
		const { t, peers } = rig()
		t.host.start()
		nav(t, 'c')
		t.type('\r')
		peers.publish('slot-1', 'idle', { account: 'work' })
		peers.publish('slot-2', 'idle')
		const text = (await lines(t)).split('\n')
		expect(text.find((l) => l.includes('session 1'))).toContain('work')
		expect(text.find((l) => l.includes('session 2'))).not.toContain('work')
	})

	it("prefers the record of the session's own process over a copy from a nested run", () => {
		const { t, peers } = rig()
		t.host.start()
		peers.publish('slot-1', 'idle', { pid: 999, startedAt: 1 })
		peers.records_.push({
			...(peers.records_[0] as PeerRecord),
			sessionId: 'nested',
			pid: 1000,
			state: 'busy',
			startedAt: 5,
		})
		t.host.readStatus()
		expect(t.host.roster.entries[0]?.reported).toBe('busy')
	})
})

describe('mouse', () => {
	const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`
	const wheel = (up: boolean, x: number, y: number) => `\x1b[<${up ? 64 : 65};${x + 1};${y + 1}M`

	it('clicks a space and a session', async () => {
		const { t } = rig({
			listed: [{ cwd: '/work/site', name: 'site', sessions: 2 }],
		})
		t.host.start()
		let screen = await lines(t)
		let row = screen.split('\n').findIndex((l) => l.includes('2 site'))
		t.type(click(5, row))
		expect(t.host.roster.selected?.spaceId).toBe('space-2')
		expect(t.spawned).toHaveLength(2)
		screen = await lines(t)
		row = screen.split('\n').findIndex((l) => l.includes('session 2'))
		t.type(click(5, row))
		expect(t.host.roster.selected?.label).toBe('session 2')
		expect(t.spawned).toHaveLength(3)
		// Clicking the session area while navigating gives the keyboard back.
		nav(t, '')
		t.type(click(60, 5))
		t.type('x')
		expect((t.spawned[2] as FakePty).writes).toEqual(['x'])
	})

	it("scrolls a session's history with the wheel and returns on a key", async () => {
		const { t } = rig()
		t.host.start()
		const pty = t.spawned[0] as FakePty
		pty.print(`${Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\r\n')}`)
		let screen = await lines(t)
		expect(screen).toContain('line 79')
		expect(screen).not.toContain('line 40')
		t.type(wheel(true, 60, 5))
		t.type(wheel(true, 60, 5))
		screen = await lines(t)
		expect(screen).toContain('Scrolled back')
		expect(screen).not.toContain('line 79')
		t.type(wheel(false, 60, 5))
		t.type(wheel(false, 60, 5))
		screen = await lines(t)
		expect(screen).not.toContain('Scrolled back')
		t.type(wheel(true, 60, 5))
		t.type('k')
		expect(pty.writes).toEqual(['k'])
		expect(await lines(t)).not.toContain('Scrolled back')
	})

	it('scrolls the sidebar and keeps its mouse reports away from the session', async () => {
		const { t } = rig(
			{
				listed: Array.from({ length: 12 }, (_, i) => ({
					cwd: `/work/s${i}`,
					name: `s${i}`,
					sessions: 1,
				})),
			},
			{ columns: 100, rows: 14 },
		)
		t.host.start()
		let screen = await lines(t)
		// The shown space and its sessions stay in view while the spaces list is longer than the room.
		expect(screen).toContain('1 namzu')
		expect(screen).toContain('session 1')
		expect(screen).not.toContain('13 s11')
		t.type(wheel(false, 5, 3))
		t.type(wheel(false, 5, 3))
		t.type(wheel(false, 5, 3))
		screen = await lines(t)
		expect(screen).toContain('13 s11')
		expect(screen).toContain('session 1')
		expect((t.spawned[0] as FakePty).writes).toEqual([])
	})

	it('asks the terminal for mouse reports and turns them off on the way out', () => {
		const { t } = rig()
		t.host.start()
		expect(t.written.join('')).toContain('\x1b[?1006h')
		t.host.quit()
		;(t.spawned[0] as FakePty).end(0)
		expect(t.written.join('')).toContain('\x1b[?1006l')
	})
})
