import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import type { HostAccount, SessionRequest } from '../host.js'
import { type SavedLayout, type SpacesStore, parseLayout } from '../store.js'
import { FakePeers } from './support/fake-peers.js'
import { setup } from './support/harness.js'

const ACCOUNTS: HostAccount[] = [
	{ id: 'openai:free-a', label: 'free-a', provider: 'openai' },
	{ id: 'openai:free-b', label: 'free-b', provider: 'openai' },
]

class MemoryStore implements SpacesStore {
	saved: SavedLayout[] = []
	constructor(private initial?: SavedLayout) {}
	load() {
		return this.initial
	}
	save(layout: SavedLayout) {
		this.saved.push(layout)
	}
	get last(): SavedLayout | undefined {
		return this.saved.at(-1)
	}
}

function rig(extra: Parameters<typeof setup>[1] = {}) {
	const peers = new FakePeers()
	const requests: SessionRequest[] = []
	let n = 0
	const t = setup(
		{ columns: 100, rows: 30 },
		{
			peers,
			newSlot: () => `slot-${++n}`,
			spec: (request) => {
				requests.push(request)
				return { file: 'node', args: ['bin.js'], cwd: request.cwd, env: {} }
			},
			...extra,
		},
	)
	return { t, peers, requests }
}

const nav = (t: ReturnType<typeof setup>, keys: string) => {
	t.type('\x02')
	t.type(keys)
}

async function text(t: ReturnType<typeof setup>): Promise<string> {
	await t.frame()
	return (await t.screen()).join('\n')
}

describe('accounts in the sidebar', () => {
	it('shows the account a session reports, follows a switch, and marks a spent allowance', async () => {
		const { t, peers } = rig()
		t.host.start()
		peers.publish('slot-1', 'idle', { account: 'free-a' })
		expect(await text(t)).toContain('free-a')
		peers.publish('slot-1', 'idle', { account: 'free-b' })
		const switched = await text(t)
		expect(switched).toContain('free-b')
		expect(switched).not.toContain('free-a')
		peers.publish('slot-1', 'idle', { account: 'free-b', limited: true })
		expect(await text(t)).toContain('may be limited')
		peers.publish('slot-1', 'idle', {
			account: 'free-b',
			limited: true,
			limitedUntil: new Date(2030, 0, 1, 15, 40).getTime(),
		})
		expect(await text(t)).toMatch(/limited until/)
		peers.publish('slot-1', 'idle')
		const back = await text(t)
		expect(back).not.toContain('limited')
		expect(back).not.toContain('free-b')
	})
})

describe('starting a session on an account', () => {
	it('starts at once when there are no extra accounts', () => {
		const { t, requests } = rig({ accounts: () => [] })
		t.host.start()
		nav(t, 'n')
		expect(t.spawned).toHaveLength(2)
		expect(requests[1]?.account).toBeUndefined()
	})

	it('asks which account, defaults to the one the space used last, and remembers the pick', async () => {
		const { t, requests } = rig({ accounts: () => ACCOUNTS })
		t.host.start()
		nav(t, 'n')
		expect(t.spawned).toHaveLength(1)
		const asking = await text(t)
		expect(asking).toContain('Start a session in namzu on:')
		expect(asking).toContain('Usual sign-in')
		t.type('j')
		t.type('\r')
		expect(requests[1]?.account).toBe('openai:free-a')
		// Next time the picker opens on that account: enter alone repeats it.
		nav(t, 'n')
		t.type('\r')
		expect(requests[2]?.account).toBe('openai:free-a')
		// Moving down and choosing the second one.
		nav(t, 'n')
		t.type('j')
		t.type('\r')
		expect(requests[3]?.account).toBe('openai:free-b')
	})

	it('leaves the picker with escape and starts nothing', async () => {
		const { t } = rig({ accounts: () => ACCOUNTS })
		t.host.start()
		nav(t, 'n')
		t.type('\x1b')
		expect(t.spawned).toHaveLength(1)
		expect(await text(t)).not.toContain('Start a session in')
	})

	it('makes the account a space was moved to by /auth the one it offers first', async () => {
		const { t, peers, requests } = rig({ accounts: () => ACCOUNTS })
		t.host.start()
		peers.publish('slot-1', 'idle', { account: 'free-b' })
		nav(t, 'n')
		t.type('\r')
		expect(requests[1]?.account).toBe('openai:free-b')
	})

	it('keeps the account a session was moved to, not the one it started on', () => {
		const store = new MemoryStore()
		const { t, peers } = rig({ accounts: () => ACCOUNTS, store })
		t.host.start()
		nav(t, 'n')
		t.type('j')
		t.type('\r')
		peers.publish('slot-2', 'idle', { account: 'free-b' })
		expect(t.host.snapshot().spaces[0]?.sessions[1]?.pickedAccount).toBe('openai:free-b')
		peers.publish('slot-2', 'idle')
		expect(t.host.snapshot().spaces[0]?.sessions[1]?.pickedAccount).toBeUndefined()
	})
})

describe('remembering the layout', () => {
	it('writes spaces, sessions, accounts and focus, and writes once for a burst', async () => {
		const store = new MemoryStore()
		const { t, peers } = rig({ store, accounts: () => ACCOUNTS })
		t.host.start()
		peers.publish('slot-1', 'idle', { account: 'free-a', conversationId: 'conv-1' })
		nav(t, 'n')
		t.type('\r')
		await t.frame()
		expect(store.saved).toHaveLength(1)
		const layout = store.last as SavedLayout
		expect(layout.spaces).toHaveLength(1)
		expect(layout.spaces[0]?.sessions[0]).toMatchObject({
			conversationId: 'conv-1',
			account: 'free-a',
		})
		expect(layout.spaces[0]?.sessions).toHaveLength(2)
		expect(layout.focus).toEqual({ space: 0, session: 1 })
	})

	it('removes a closed session from the list but not its conversation from disk', async () => {
		const store = new MemoryStore()
		const { t, peers } = rig({ store })
		t.host.start()
		peers.publish('slot-1', 'idle', { conversationId: 'conv-1' })
		nav(t, 'n')
		nav(t, 'd')
		t.type('y')
		await t.frame()
		expect(store.last?.spaces[0]?.sessions).toHaveLength(1)
		expect(store.last?.spaces[0]?.sessions[0]?.conversationId).toBe('conv-1')
	})

	it('writes the layout when the host closes', async () => {
		const store = new MemoryStore()
		const { t } = rig({ store })
		t.host.start()
		t.host.quit()
		;(t.spawned[0] as FakePty).end(0)
		await t.host.done
		expect(store.last?.spaces).toHaveLength(1)
	})

	it('forgets everything when the last session is closed', async () => {
		const store = new MemoryStore()
		const { t } = rig({ store })
		t.host.start()
		nav(t, 'd')
		t.type('y')
		;(t.spawned[0] as FakePty).end(0)
		await t.host.done
		expect(store.last).toEqual({ version: 1, spaces: [] })
	})
})

describe('restoring the layout', () => {
	const layout: SavedLayout = {
		version: 1,
		spaces: [
			{
				name: 'namzu',
				cwd: '/work/namzu',
				sessions: [
					{ label: 'session 1', conversationId: 'conv-a', account: 'free-a' },
					{ label: 'notes' },
				],
			},
			{
				name: 'site',
				cwd: '/work/site',
				sessions: [
					{ label: 'session 1', conversationId: 'conv-b', pickedAccount: 'openai:free-b' },
				],
			},
		],
		focus: { space: 1, session: 0 },
	}

	it('lists every saved session, starts only the focused one, and resumes its conversation', async () => {
		const { t, requests } = rig({ restored: layout, store: new MemoryStore() })
		t.host.start()
		expect(t.spawned).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			cwd: '/work/site',
			resume: 'conv-b',
			account: 'openai:free-b',
			first: false,
		})
		const shown = await text(t)
		expect(shown).toContain('1 namzu')
		expect(shown).toContain('2 site')
		// The other space opens lazily and resumes its own conversation, on its account.
		t.type('\x02')
		t.type('1')
		t.type('\r')
		expect(requests[1]).toMatchObject({
			cwd: '/work/namzu',
			resume: 'conv-a',
			accountLabel: 'free-a',
		})
		expect(t.spawned).toHaveLength(2)
	})

	it('shows the saved account label before the session is started', async () => {
		const { t } = rig({ restored: layout })
		t.host.start()
		t.type('\x02')
		t.type('1')
		expect(await text(t)).toContain('free-a')
		expect(t.spawned).toHaveLength(1)
	})

	it('starts a fresh first session for the command folder when it is new or the command has options', () => {
		const a = rig({ restored: layout })
		a.t.host.start()
		expect(a.requests[0]?.resume).toBe('conv-b')
		const b = rig({
			restored: { ...layout, spaces: layout.spaces.slice(1) },
		})
		b.t.host.start()
		expect(b.requests[0]).toMatchObject({ cwd: '/work/namzu', first: true })
		expect(b.requests[0]?.resume).toBeUndefined()
		const c = rig({ restored: layout, freshFirst: true })
		c.t.host.start()
		expect(c.requests[0]).toMatchObject({ cwd: '/work/namzu', first: true })
	})

	it('refuses a second writer: a conversation open elsewhere is not started', async () => {
		let busy = true
		const asked: string[] = []
		const { t, requests } = rig({
			restored: layout,
			inUseElsewhere: async ({ conversationId }) => {
				asked.push(conversationId)
				return busy
			},
		})
		t.host.start()
		await Promise.resolve()
		await Promise.resolve()
		expect(t.spawned).toHaveLength(0)
		const shown = await text(t)
		expect(shown).toContain('is open in another terminal')
		expect(shown).toContain('open in another terminal')
		expect(shown).not.toContain('could not start')
		// Closed elsewhere: enter asks again and now starts it.
		busy = false
		t.type('\r')
		await Promise.resolve()
		await Promise.resolve()
		expect(asked).toEqual(['conv-b', 'conv-b'])
		expect(t.spawned).toHaveLength(1)
		expect(requests[0]?.resume).toBe('conv-b')
	})
})

describe('reading the saved layout', () => {
	it('keeps what is well formed and drops the rest', () => {
		const parsed = parseLayout({
			version: 1,
			spaces: [
				{ name: 'a', cwd: '/a', sessions: [{ label: 'x', conversationId: 'c' }, { nope: 1 }] },
				{ name: 'b', cwd: '/b', sessions: [] },
				'junk',
			],
			focus: { space: 0, session: 9 },
		})
		expect(parsed?.spaces).toHaveLength(1)
		expect(parsed?.spaces[0]?.sessions).toHaveLength(1)
		expect(parsed?.focus).toBeUndefined()
		expect(parseLayout({ version: 2, spaces: [] })).toBeUndefined()
		expect(parseLayout(null)).toBeUndefined()
		expect(parseLayout({ version: 1, spaces: [] })).toBeUndefined()
	})
})
