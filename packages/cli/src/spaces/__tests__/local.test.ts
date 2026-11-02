import type { PeerRecord } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { HeadlessScreen } from '../../terminal/screen.js'
import type { PeerSource } from '../peers.js'
import type { LocalPaneSession, SessionEnding, SessionStatus } from '../session.js'
import { spacesSignal } from '../signal.js'
import type { SavedLayout } from '../store.js'
import { setup } from './support/harness.js'

/** The conversation the host runs inside of, as the host sees it. */
class FakeLocal implements LocalPaneSession {
	readonly local = true as const
	status: SessionStatus = 'running'
	ending: SessionEnding | undefined
	readonly pid = 4242
	screen = new HeadlessScreen(80, 24, 100)
	readonly events: string[] = []
	readonly writes: string[] = []
	readonly sizes: { cols: number; rows: number }[] = []
	private listener: (() => void) | undefined
	attach(cols: number, rows: number): void {
		this.events.push('attach')
		this.sizes.push({ cols, rows })
		this.screen.dispose()
		this.screen = new HeadlessScreen(cols, rows, 100)
	}
	detach(): void {
		this.events.push('detach')
	}
	observe(listener: () => void): void {
		this.listener = listener
	}
	write(data: string): void {
		this.writes.push(data)
	}
	resize(cols: number, rows: number): void {
		this.sizes.push({ cols, rows })
	}
	stop(): void {
		this.events.push('stop')
	}
	dispose(): void {
		this.screen.dispose()
	}
	print(text: string): void {
		this.screen.write(text)
		this.listener?.()
	}
	exit(): void {
		this.status = 'exited'
		this.ending = 'finished'
		this.listener?.()
	}
}

const saved = (...sessions: { label: string; conversationId?: string }[]): SavedLayout => ({
	version: 2,
	spaces: [
		{
			name: 'namzu',
			cwd: '/work/namzu',
			tabs: sessions.map((s) => ({ tree: { session: s } })),
		},
		{
			name: 'site',
			cwd: '/work/site',
			tabs: [
				{
					tree: {
						session: { label: 'site work', conversationId: 'conv-site' },
					},
				},
			],
		},
	],
})

const record = (extra: Partial<PeerRecord>): PeerRecord =>
	({
		pid: 4242,
		startedAt: 1,
		address: 'a',
		state: 'idle',
		...extra,
	}) as unknown as PeerRecord

function rig(
	options: {
		conversationId?: string | undefined
		restored?: SavedLayout
		records?: () => PeerRecord[]
	} = {},
) {
	const local = new FakeLocal()
	const peers: PeerSource = {
		records: options.records ?? (() => []),
		ping: () => Promise.resolve(undefined),
	}
	const t = setup(
		{ columns: 120, rows: 36 },
		{
			local: { session: local, conversationId: () => options.conversationId },
			...(options.restored ? { restored: options.restored } : {}),
			peers,
		},
	)
	return { t, local }
}

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

describe('the host inside a conversation', () => {
	it('draws nothing and starts nothing until the spaces screen is asked for', async () => {
		const { t, local } = rig({
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		expect(t.written).toEqual([])
		expect(t.spawned).toHaveLength(0)
		expect(local.events).toEqual([])
		expect(t.host.visible).toBe(false)
		// Keys that reach it while hidden are not its business.
		t.type('abc')
		expect(local.writes).toEqual([])
	})

	it('makes the pane that carries the conversation id the running session, without a second copy', () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }, { label: 'notes' }),
		})
		t.host.start()
		const entries = t.host.roster.entries
		expect(entries).toHaveLength(3)
		const mine = entries.find((e) => e.conversationId === 'conv-a')
		expect(mine?.child).toBe(local)
		expect(mine?.resume).toBeUndefined()
		expect(t.host.roster.selected).toBe(mine)
		t.host.openSpaces()
		// The other pane of that space is started lazily; the matched one never is.
		expect(t.spawned.map((p) => p.options.cwd)).toEqual([])
		expect(local.events).toEqual(['attach'])
	})

	it('adds the conversation as a new tab of its folder’s space when no pane carries its id', () => {
		const { t, local } = rig({
			conversationId: 'conv-new',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		const space = t.host.roster.spaces.find((s) => s.cwd === '/work/namzu')
		expect(space?.tabs).toHaveLength(2)
		expect(t.host.roster.selected?.child).toBe(local)
		expect(t.host.roster.spaceOf(t.host.roster.selected as never)).toBe(space)
		expect(t.host.roster.entries.filter((e) => e.child === local)).toHaveLength(1)
	})

	it('creates the folder’s space when the layout has none, and works with no saved layout at all', () => {
		const { t, local } = rig({ restored: saved() })
		t.host.start()
		expect(t.host.roster.spaces.map((s) => s.cwd)).toContain('/work/namzu')
		expect(t.host.roster.selected?.child).toBe(local)
		const bare = rig()
		bare.t.host.start()
		expect(bare.t.host.roster.entries).toHaveLength(1)
		expect(bare.t.host.roster.selected?.child).toBe(bare.local)
	})

	it('shows the spaces screen with the conversation as a pane, sized to it, and the keys on the sidebar', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		expect(t.written[0]).toContain('\x1b[?1049h')
		expect(local.sizes[0]).toMatchObject({ cols: 120 - 26, rows: 35 })
		local.print('hello from the conversation')
		await t.frame()
		const lines = (await t.screen()).join('\n')
		expect(lines).toContain('hello from the conversation')
		expect(lines).toContain('NAVIGATE')
		expect(t.host.visible).toBe(true)
	})

	it('gives the main screen back before the conversation unmounts, once, and quits without touching it again', () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		// Not shown yet: nothing to give back.
		expect(t.host.releaseTerminal()).toBe(false)
		t.host.openSpaces()
		const before = t.written.length
		expect(t.host.releaseTerminal()).toBe(true)
		const out = t.written.slice(before).join('')
		expect(out).toContain('\x1b[?1049l')
		// The conversation is told to print its history only after the alternate screen is gone.
		expect(local.events).toEqual(['attach', 'detach'])
		expect(t.host.visible).toBe(false)
		expect(t.host.releaseTerminal()).toBe(false)
		// The conversation ends; the host closes without leaving the alternate screen a second time.
		local.exit()
		const mark = t.written.length
		t.host.quit()
		expect(t.written.slice(mark).join('')).not.toContain('\x1b[?1049l')
	})

	it('moves through the sessions with up and down, starting the one it lands on, and names what is live', async () => {
		const { t } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		expect(t.host.roster.selected?.label).toBe('site work')
		expect(t.spawned).toHaveLength(1)
		expect(t.spawned[0]?.options.cwd).toBe('/work/site')
		;(t.spawned[0] as FakePty).print('the site session')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('the site session')
		t.type(UP)
		expect(t.host.roster.selected?.child?.local).toBe(true)
	})

	it('opens a child full screen with right, on the whole terminal, and a hosted ← brings the screen back', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		const pty = t.spawned[0] as FakePty
		t.type(RIGHT)
		expect(pty.resizes.at(-1)).toEqual({ cols: 120, rows: 36 })
		pty.print('full screen child')
		await t.frame()
		let lines = await t.screen()
		expect(lines[0]).toContain('full screen child')
		expect(lines.join('\n')).not.toContain('spaces')
		// Typing goes to the child.
		t.type('hi')
		expect(pty.writes).toEqual(['hi'])
		// The child's ← arrives as a private message in its output and is not shown.
		pty.print(spacesSignal('zoom-out'))
		expect(pty.resizes.at(-1)).toEqual({ cols: 120 - 26, rows: 35 })
		await t.frame()
		lines = await t.screen()
		expect(lines.join('\n')).toContain('NAVIGATE')
		expect(lines.join('\n')).not.toContain('7777')
		// With the sidebar focused, keys no longer reach the child.
		t.type('zz')
		expect(pty.writes).toEqual(['hi'])
		expect(local.events).toEqual(['attach'])
	})

	it('puts the keyboard back on the sidebar from a pane in the split view, for a child and for the local session', () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		const pty = t.spawned[0] as FakePty
		// Enter lets you type into the selected pane while the split stays.
		t.type('\r')
		t.type('ab')
		expect(pty.writes).toEqual(['ab'])
		pty.print(spacesSignal('zoom-out'))
		t.type('cd')
		expect(pty.writes).toEqual(['ab'])
		// The local session's composer calls the host directly.
		t.type(UP)
		t.type('\r')
		t.type('ef')
		expect(local.writes).toEqual(['ef'])
		t.host.focusSidebar()
		t.type('gh')
		expect(local.writes).toEqual(['ef'])
	})

	it('gives the terminal to the conversation with right on its pane, and takes it back on demand', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.written.length = 0
		t.type(RIGHT)
		expect(local.events).toEqual(['attach', 'detach'])
		expect(t.written.join('')).toContain('\x1b[?1049l')
		// Left alone: no frame is drawn over the conversation, and keys are not the host’s.
		t.written.length = 0
		await t.frame()
		t.type('abc')
		expect(t.written).toEqual([])
		expect(local.writes).toEqual([])
		expect(t.host.visible).toBe(false)
		// Opening again selects the conversation and puts the keys on the sidebar.
		t.host.openSpaces()
		expect(local.events).toEqual(['attach', 'detach', 'attach'])
		expect(t.written.join('')).toContain('\x1b[?1049h')
		expect(t.host.roster.selected?.child).toBe(local)
	})

	it('reads the conversation’s state from its own record, by process id', () => {
		let records: PeerRecord[] = []
		const { t } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
			records: () => records,
		})
		t.host.start()
		const mine = t.host.roster.selected
		records = [
			record({
				state: 'busy',
				account: 'free-a',
				limited: true,
				conversationId: 'conv-z',
			}),
			record({ pid: 7, state: 'idle', hostSlot: mine?.slot }),
		]
		t.host.readStatus()
		expect(mine?.reported).toBe('busy')
		expect(mine?.account).toBe('free-a')
		expect(mine?.limited).toBe(true)
		expect(mine?.conversationId).toBe('conv-z')
		expect(mine?.dot()).toBe('working')
	})

	it('asks before quitting from the sidebar, and ends the conversation and the children together', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		t.type(UP)
		// Control-C with the sidebar focused asks to quit.
		t.type('\x03')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Quit all sessions?')
		t.type('\r')
		expect(local.events).toContain('stop')
		expect((t.spawned[0] as FakePty).kills).toEqual(['SIGHUP'])
		;(t.spawned[0] as FakePty).end(0, 1)
		local.exit()
		await expect(t.host.done).resolves.toBe(0)
		expect(t.written.join('')).toContain('\x1b[?1049l')
	})

	it('restores nothing on close when the terminal already belongs to the conversation', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(RIGHT)
		t.written.length = 0
		t.host.quit()
		local.exit()
		await t.host.done
		expect(t.written).toEqual([])
	})

	it('refuses to close the pane of the conversation it runs inside of while others remain', () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }, { label: 'notes' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type('\r')
		t.type('\x02')
		t.type('x')
		expect(local.events).not.toContain('stop')
		expect(t.host.roster.entries).toHaveLength(3)
	})

	it('lets the conversation end at once when no other session is mid-turn', async () => {
		const { t } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		await expect(t.host.askLocalExit()).resolves.toBe(true)
		t.host.openSpaces()
		t.type(DOWN)
		await expect(t.host.askLocalExit()).resolves.toBe(true)
	})

	it('asks on the spaces screen before the conversation ends while another session is mid-turn', async () => {
		let records: PeerRecord[] = []
		const { t } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
			records: () => records,
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		const started = t.host.roster.selected
		records = [record({ pid: 9, state: 'busy', hostSlot: started?.slot })]
		t.host.readStatus()
		expect(started?.activity()).toBe('working')
		// Native full screen on the conversation, then it asks to end.
		t.type(UP)
		t.type(RIGHT)
		expect(t.host.visible).toBe(false)
		const answer = t.host.askLocalExit()
		expect(t.host.visible).toBe(true)
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Quit all sessions?')
		t.type('\x1b')
		await expect(answer).resolves.toBe(false)
		expect((t.spawned[0] as FakePty).kills).toEqual([])
		// Asking again and confirming lets it go; the children are hung up by the end that follows.
		const again = t.host.askLocalExit()
		await t.frame()
		t.type('\r')
		await expect(again).resolves.toBe(true)
		expect((t.spawned[0] as FakePty).kills).toEqual([])
	})

	it('goes back to the split view when the session shown full screen ends', async () => {
		const { t } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type(DOWN)
		const pty = t.spawned[0] as FakePty
		t.type(RIGHT)
		await t.frame()
		expect((await t.screen())[0]).not.toContain('NAVIGATE')
		pty.end(0)
		await t.frame()
		const shown = (await t.screen()).join('\n')
		expect(shown).toContain('NAVIGATE')
		// The keys are the sidebar's again, not the dead session's.
		t.type(UP)
		expect(t.host.roster.selected?.child?.local).toBe(true)
	})

	it('runs the prefix command from the sidebar the way it does from a pane', async () => {
		const { t, local } = rig({
			conversationId: 'conv-a',
			restored: saved({ label: 'session 1', conversationId: 'conv-a' }),
		})
		t.host.start()
		t.host.openSpaces()
		t.type('\x02')
		t.type('q')
		await t.frame()
		expect((await t.screen()).join('\n')).toContain('Quit all sessions?')
		expect(local.writes).toEqual([])
	})

	it('saves the conversation’s id with the layout', () => {
		const { t } = rig({
			conversationId: 'conv-b',
			records: () => [record({ conversationId: 'conv-b' })],
		})
		t.host.start()
		t.host.readStatus()
		const snapshot = t.host.snapshot()
		expect(JSON.stringify(snapshot)).toContain('conv-b')
	})
})
