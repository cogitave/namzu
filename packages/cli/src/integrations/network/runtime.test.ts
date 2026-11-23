import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import {
	BROWSE_WINDOW_MS,
	HOLD_EXPIRY_MS,
	type NetworkEvent,
	createDiscoveryHub,
	createFakeDiscovery,
	createManualClock,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type LivePeers, openLivePeers, peerMailMessage } from '../peers/runtime.js'
import { type NetworkRuntime, createNetworkRuntime } from './runtime.js'

const loopback = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
	lo: [
		{
			address: '127.0.0.1',
			netmask: '255.0.0.0',
			family: 'IPv4',
			mac: '00:00:00:00:00:00',
			internal: true,
			cidr: '127.0.0.1/8',
		},
	],
})

const roots: string[] = []
const runtimes: NetworkRuntime[] = []
const sessions: LivePeers[] = []
afterEach(async () => {
	for (const s of sessions.splice(0)) await s.close()
	for (const r of runtimes.splice(0)) await r.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

interface Box {
	readonly name: string
	readonly home: string
	readonly rt: NetworkRuntime
	readonly notices: string[]
	/** Passing footer notices (key and text), and every count of waiting join requests the terminal was told. */
	readonly quiet: Array<{ key: string; text: string }>
	readonly waiting: number[]
	readonly events: NetworkEvent[]
	readonly session: LivePeers
	readonly setMode: (mode: string) => void
	/** Resolves with the first event, now or later, that matches. */
	until(match: (event: NetworkEvent) => boolean): Promise<NetworkEvent>
}

async function box(
	world: {
		hub: ReturnType<typeof createDiscoveryHub>
		clock: ReturnType<typeof createManualClock>
	},
	name: string,
	sessionName: string,
	settings: {
		acceptMail?: 'members' | 'hold' | 'off'
		autoAdmit?: 'trusted-networks' | 'always' | 'never'
		identity?: () => string | undefined
	} = {},
	discovery?: () => ReturnType<typeof createDiscoveryHub>['create'] extends () => infer D
		? D
		: never,
): Promise<Box> {
	const root = mkdtempSync(join(tmpdir(), 'nr-'))
	roots.push(root)
	const home = join(root, 'h')
	const cwd = join(root, name)
	mkdirSync(cwd, { recursive: true })
	const notices: string[] = []
	const quiet: Array<{ key: string; text: string }> = []
	const waiting: number[] = []
	const events: NetworkEvent[] = []
	const waiters: Array<{
		match: (e: NetworkEvent) => boolean
		resolve: (e: NetworkEvent) => void
	}> = []
	let mode = 'classify'
	const own: { ref: string | undefined } = { ref: undefined }
	const rt = createNetworkRuntime({
		home,
		version: 'fixture',
		env: {},
		settings: {
			enabled: 'auto',
			acceptMail: settings.acceptMail ?? 'members',
			autoAdmit: settings.autoAdmit ?? 'trusted-networks',
			machineName: name,
		},
		networkIdentity: async () => settings.identity?.(),
		interactive: true,
		notify: (text) => notices.push(text),
		notice: (key, text) => quiet.push({ key, text }),
		onJoinRequests: (count) => waiting.push(count),
		ownRef: () => own.ref,
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		discovery: discovery ?? (() => world.hub.create()),
		listenPort: 0,
		hostname: name,
		onEvent: (event) => {
			events.push(event)
			for (const w of [...waiters]) {
				if (w.match(event)) {
					waiters.splice(waiters.indexOf(w), 1)
					w.resolve(event)
				}
			}
		},
	})
	runtimes.push(rt)
	await rt.refresh()
	const session = await openLivePeers({
		home,
		cwd,
		version: 'fixture',
		env: {},
		mode: () => mode,
		owner: () => 0,
		state: () => 'idle',
		ready: () => true,
		available: () => {},
		report: (text) => notices.push(text),
		name: () => sessionName,
		roles: rt.roles,
		audit: (entry) => rt.audit(entry),
		network: () => (rt.decision.run ? rt.link : undefined),
	})
	sessions.push(session)
	own.ref = session.ref
	return {
		name,
		home,
		rt,
		notices,
		quiet,
		waiting,
		events,
		session,
		setMode: (next) => {
			mode = next
			session.publish()
		},
		until: (match) => {
			const seen = events.find(match)
			if (seen) return Promise.resolve(seen)
			return new Promise((resolve) => waiters.push({ match, resolve }))
		},
	}
}

/** Two machines on an in-process LAN: the first founds the network, the second joins it with one Allow. */
async function pair(settings: { acceptMail?: 'members' | 'hold' | 'off' } = {}) {
	const world = { hub: createDiscoveryHub(), clock: createManualClock() }
	const a = await box(world, 'studio-air', 'conductor')
	const founded = a.until((e) => e.type === 'founded')
	world.clock.advance(BROWSE_WINDOW_MS)
	await founded
	const b = await box(world, 'desk-linux', 'builder', settings)
	const asked = a.until((e) => e.type === 'join-request')
	world.clock.advance(BROWSE_WINDOW_MS)
	await asked
	const summary = await a.rt.control.summary()
	expect(summary.joinRequests).toHaveLength(1)
	expect(summary.joinRequests[0]?.name).toBe('desk-linux')
	const joined = b.until((e) => e.type === 'joined')
	await a.rt.control.allow(summary.joinRequests[0]?.requestId as string)
	await joined
	// The machines have each other's addresses once they have greeted; `peers add` is the way to say so by hand.
	await a.rt.control.add(`127.0.0.1:${(await b.rt.control.summary()).port}`)
	await b.rt.control.add(`127.0.0.1:${(await a.rt.control.summary()).port}`)
	return { world, a, b }
}

describe('a machine that starts with no network', () => {
	const world = () => ({ hub: createDiscoveryHub(), clock: createManualClock() })

	it('two machines started together end in one network, with one line and one Allow and nothing typed', async () => {
		const w = world()
		const a = await box(w, 'studio-air', 'conductor')
		const b = await box(w, 'desk-linux', 'builder')
		// Both browsed for the whole window, heard nothing, and each founded a network of its own.
		const foundedA = a.until((e) => e.type === 'founded')
		const foundedB = b.until((e) => e.type === 'founded')
		w.clock.advance(BROWSE_WINDOW_MS)
		await foundedA
		await foundedB
		// The younger one asks the older; the older sees one line with the code.
		const asked = await Promise.race([
			a.until((e) => e.type === 'join-request').then(() => ({ older: a, younger: b })),
			b.until((e) => e.type === 'join-request').then(() => ({ older: b, younger: a })),
		])
		await asked.younger.until((e) => e.type === 'join-waiting')
		await asked.older.rt.refresh()
		await asked.younger.rt.refresh()
		// A passing footer line and a count, never a transcript row.
		expect(asked.older.notices.some((n) => n.includes('wants to join'))).toBe(false)
		expect(asked.older.quiet).toHaveLength(1)
		expect(asked.older.quiet[0]?.text).toMatch(
			/ wants to join your Namzu network\. \/peers to allow or deny\./,
		)
		expect(asked.older.waiting.at(-1)).toBe(1)
		const waiting = asked.younger.notices.find((n) => n.includes('to let this machine join'))
		expect(waiting).toMatch(/code \d{3} \d{3}\)\. .*\/peers cancel to withdraw/)
		const summary = await asked.older.rt.control.summary()
		const joined = asked.younger.until((e) => e.type === 'joined')
		await asked.older.rt.control.allow(summary.joinRequests[0]?.requestId as string)
		await joined
		expect((await asked.older.rt.control.summary()).members).toBe(2)
		expect((await asked.younger.rt.control.summary()).members).toBe(2)
	})

	it('a person can cancel the request it is waiting on', async () => {
		const w = world()
		const a = await box(w, 'studio-air', 'conductor')
		const founded = a.until((e) => e.type === 'founded')
		w.clock.advance(BROWSE_WINDOW_MS)
		await founded
		const b = await box(w, 'desk-linux', 'builder')
		const asked = a.until((e) => e.type === 'join-request')
		w.clock.advance(BROWSE_WINDOW_MS)
		await asked
		await b.until((e) => e.type === 'join-waiting')
		expect((await b.rt.control.summary()).joining?.code).toMatch(/^\d{3} \d{3}$/)
		expect(await b.rt.control.cancelJoin()).toBe(true)
		await b.until((e) => e.type === 'join-ended')
		await b.rt.refresh()
		expect((await b.rt.control.summary()).joining).toBeUndefined()
		expect(b.notices.join('\n')).toContain('You withdrew the request to join')
		expect(await b.rt.control.cancelJoin()).toBe(false)
		// The other machine's line goes away with it.
		await a.until((e) => e.type === 'join-settled')
		expect((await a.rt.control.summary()).joinRequests).toEqual([])
	})

	it('hears two networks nearby: joins neither, says so in one line, and offers each address', async () => {
		const first = world()
		const second = world()
		const a = await box(first, 'studio-air', 'conductor')
		const c = await box(second, 'office-pc', 'writer')
		const foundedA = a.until((e) => e.type === 'founded')
		const foundedC = c.until((e) => e.type === 'founded')
		first.clock.advance(BROWSE_WINDOW_MS)
		second.clock.advance(BROWSE_WINDOW_MS)
		await foundedA
		await foundedC
		const fake = createFakeDiscovery()
		const w = world()
		const d = await box(w, 'desk-linux', 'builder', {}, () => fake)
		const portA = (await a.rt.control.summary()).port as number
		const portC = (await c.rt.control.summary()).port as number
		const netOf = async (m: Box) => (await m.rt.control.summary()).machine?.id ?? m.name
		fake.emitFound({ netId: (await netOf(a)).slice(0, 16), host: '127.0.0.1', port: portA })
		fake.emitFound({ netId: (await netOf(c)).slice(0, 16), host: '127.0.0.1', port: portC })
		w.clock.advance(BROWSE_WINDOW_MS)
		await d.until((e) => e.type === 'state' && e.state === 'ambiguous')
		const summary = await d.rt.refresh()
		expect(summary?.state).toBe('ambiguous')
		expect(summary?.nearby.map((n) => n.port).sort()).toEqual([portA, portC].sort())
		expect(d.notices.filter((n) => n.includes('Namzu networks are nearby'))).toEqual([
			'2 Namzu networks are nearby and this machine asked none. /peers to pick yours.',
		])
		expect((await a.rt.control.summary()).joinRequests).toEqual([])
		expect((await c.rt.control.summary()).joinRequests).toEqual([])
	})
})

describe('a machine with several terminals asks once', () => {
	const world = () => ({ hub: createDiscoveryHub(), clock: createManualClock() })

	it('terminals that take over from one another leave one request, one footer mark and one passing line', async () => {
		const w = world()
		const a = await box(w, 'studio-air', 'conductor')
		const founded = a.until((e) => e.type === 'founded')
		w.clock.advance(BROWSE_WINDOW_MS)
		await founded
		const b = await box(w, 'desk-linux', 'builder')
		const asked = a.until((e) => e.type === 'join-request')
		w.clock.advance(BROWSE_WINDOW_MS)
		await asked
		const first = (await a.rt.control.summary()).joinRequests[0]
		expect(first).toBeDefined()
		await a.rt.refresh()
		// Three more terminals of that machine open and close in turn, each leading for a while.
		const seen: string[] = []
		let current: NetworkRuntime = b.rt
		for (let n = 1; n <= 3; n++) {
			await current.close()
			const next = createNetworkRuntime({
				home: b.home,
				version: 'fixture',
				env: {},
				settings: { enabled: 'auto', acceptMail: 'members', autoAdmit: 'trusted-networks' },
				networkIdentity: async () => undefined,
				interactive: true,
				notify: () => {},
				clock: w.clock,
				interfaces: loopback,
				allowLoopback: true,
				discovery: () => w.hub.create(),
				listenPort: 0,
				pid: process.pid + n,
				isAlive: () => true,
			})
			current = next
			runtimes.push(next)
			await next.refresh()
			w.clock.advance(BROWSE_WINDOW_MS)
			await vi.waitFor(async () => expect((await next.control.summary()).joining).toBeDefined())
			const summary = await a.rt.refresh()
			seen.push(summary?.joinRequests.map((j) => `${j.requestId}:${j.code}`).join(',') ?? '')
		}
		expect(new Set(seen).size).toBe(1)
		expect(seen[0]).toBe(`${first?.requestId}:${first?.code}`)
		expect(a.quiet).toHaveLength(1)
		expect(a.notices.filter((n) => n.includes('wants to join'))).toEqual([])
		// One mark, however often it asked.
		expect(a.waiting.filter((n) => n > 0)).toEqual([1])
		// The one Allow still reaches the terminal that holds the ask now.
		await a.rt.control.allow(first?.requestId as string)
		await a.rt.refresh()
		expect(a.waiting.at(-1)).toBe(0)
		await vi.waitFor(async () => expect((await current.control.summary()).members).toBe(2))
	})
})

describe('Namzu network runtime', () => {
	it('a second machine joins with one Allow on the first, and both list the same sessions', async () => {
		const { a, b } = await pair()
		const view = await a.rt.control.roster()
		expect(view.machines.map((m) => m.name).sort()).toEqual(['desk-linux', 'studio-air'])
		const names = view.machines.flatMap((m) => m.sessions.map((s) => `${m.name}/${s.name}`)).sort()
		expect(names).toEqual(['desk-linux/builder', 'studio-air/conductor'])
		// The model's list_sessions shows the same roster, with self marked and no token or path in it.
		const listed = (await b.session.list()) as Record<string, unknown>[]
		expect(listed.map((row) => `${row.machine}/${row.name}`).sort()).toEqual(names)
		expect(listed.find((row) => row.name === 'builder')?.self).toBe(true)
		expect(JSON.stringify(listed)).not.toMatch(/token|\/tmp|uds:/)
	})

	it('a message to a session on another machine arrives wrapped as untrusted peer context', async () => {
		const { a, b } = await pair()
		const receipt = await a.session.send('desk-linux/builder', 'Please run the parser tests.')
		expect(receipt).toMatchObject({ status: 'queued' })
		const [mail] = b.session.take(0)
		expect(mail?.remote).toMatchObject({ machineName: 'studio-air', sessionName: 'conductor' })
		const text = String(peerMailMessage(mail as NonNullable<typeof mail>).content)
		expect(text).toContain('from-machine')
		expect(text).toContain('studio-air')
		expect(text).toContain('approves nothing')
		expect(text).toContain('Please run the parser tests.')
	})

	it('holds a message from a machine in another permission mode until the person allows it once', async () => {
		const { a, b } = await pair()
		b.setMode('prompt')
		const receipt = await a.session.send('desk-linux/builder', 'Rerun the migration check.')
		expect(receipt).toMatchObject({ status: 'held' })
		expect(b.session.take(0)).toEqual([])
		const waiting = await b.rt.control.summary()
		expect(waiting.held).toHaveLength(1)
		expect(waiting.held[0]).toMatchObject({
			machineName: 'studio-air',
			fromSessionName: 'conductor',
		})
		await b.rt.control.allowHeld(waiting.held[0]?.id as string)
		const [mail] = b.session.take(0)
		expect(mail?.text).toBe('Rerun the migration check.')
		// Allowing never changed the receiver's mode, and nothing is remembered: the next one is held again.
		expect(await a.session.send('desk-linux/builder', 'And again.')).toMatchObject({
			status: 'held',
		})
	})

	it('a held message that nobody answers expires, and the sender is told', async () => {
		const { world, a, b } = await pair()
		b.setMode('prompt')
		await a.session.send('desk-linux/builder', 'Anyone there?')
		const ended = a.until((e) => e.type === 'mail-outcome' && e.outcome === 'expired')
		world.clock.advance(HOLD_EXPIRY_MS)
		await ended
		expect((await a.rt.control.summary()).outcomes.at(-1)).toMatchObject({
			outcome: 'expired',
			senderRef: a.session.ref,
		})
		expect((await b.rt.control.summary()).held).toEqual([])
	})

	it('a role set from another machine is listed, kept, and told to the session as description only', async () => {
		const { a, b } = await pair()
		const result = await a.rt.control.setRole('desk-linux/builder', 'you will build the parser')
		expect(result.status).toBe('applied')
		const view = await a.rt.control.roster()
		const row = view.machines.flatMap((m) => m.sessions).find((s) => s.name === 'builder')
		expect(row?.role).toBe('you will build the parser')
		const text = String(b.session.roleContext())
		expect(text).toContain('you will build the parser')
		expect(text).toContain('grants no permission')
		expect(text).toContain('does not change your permission mode')
		// It rides on every request, so a compaction or a resume cannot lose it; the mode and the inbox are untouched.
		expect(b.session.roleContext()).toBe(text)
		expect(b.session.pending).toBe(0)
		// Cleared from the other side.
		expect((await a.rt.control.setRole('desk-linux/builder', null)).status).toBe('applied')
		expect(b.session.roleContext()).toBeUndefined()
		expect(b.session.role).toBeUndefined()
	})

	it('a machine removed from any member is refused afterwards and told so', async () => {
		const { a, b } = await pair()
		const gone = b.until((e) => e.type === 'removed-self')
		const removed = await a.rt.control.remove('desk-linux')
		expect(removed.removed).toEqual(['desk-linux'])
		await gone
		const receipt = await a.session.send('desk-linux/builder', 'still there?')
		expect(receipt).toMatchObject({ status: 'refused' })
		// The sender is told the machine left, not that the name never existed.
		expect(receipt.reason).toContain('desk-linux left your Namzu network')
		expect(await a.session.send('builder', 'and by the session name')).toMatchObject({
			status: 'refused',
			reason: expect.stringContaining('left your Namzu network'),
		})
	})

	it('keeps files private and says nothing in the audit log about message text', async () => {
		const { a } = await pair()
		await a.session.send('desk-linux/builder', 'SECRET-TEXT-DO-NOT-LOG')
		const dir = join(a.home, 'network')
		expect(statSync(dir).mode & 0o077).toBe(0)
		for (const file of ['machine.key.pem', 'members.json', 'leader.lock', 'control.json'])
			expect(statSync(join(dir, file)).mode & 0o077, file).toBe(0)
		// What the log may hold is who and what was decided, never the words of a message.
		const log = join(dir, 'audit.jsonl')
		if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toContain('SECRET-TEXT')
	})

	it('a second terminal on the same machine does not run a second service; it asks the first', async () => {
		const world = { hub: createDiscoveryHub(), clock: createManualClock() }
		const first = await box(world, 'studio-air', 'conductor')
		const second = createNetworkRuntime({
			home: first.home,
			version: 'fixture',
			env: {},
			settings: { enabled: 'auto', acceptMail: 'members', autoAdmit: 'trusted-networks' },
			networkIdentity: async () => undefined,
			interactive: true,
			notify: () => {},
			clock: world.clock,
			interfaces: loopback,
			allowLoopback: true,
			discovery: () => world.hub.create(),
			listenPort: 0,
			// Another terminal is another process: it has its own id, and both are alive.
			pid: process.pid + 1,
			isAlive: () => true,
		})
		runtimes.push(second)
		await second.refresh()
		expect(first.rt.isLeader).toBe(true)
		expect(second.isLeader).toBe(false)
		expect((await second.control.summary()).machine?.name).toBe('studio-air')
		// When the first closes, the second takes over within one tick.
		await first.rt.close()
		world.clock.advance(5_000)
		await second.refresh()
		expect(second.isLeader).toBe(true)
	})
})

describe('trusted networks', () => {
	const HOME = 'a1b2c3d4e5f60718'

	async function founder(autoAdmit: 'trusted-networks' | 'never' = 'trusted-networks') {
		const world = { hub: createDiscoveryHub(), clock: createManualClock() }
		const a = await box(world, 'studio-air', 'conductor', { autoAdmit, identity: () => HOME })
		const founded = a.until((e) => e.type === 'founded')
		world.clock.advance(BROWSE_WINDOW_MS)
		await founded
		return { world, a }
	}

	/** A machine that can reach only `a`: its discovery is told about nothing else. */
	async function ask(world: { clock: ReturnType<typeof createManualClock> }, a: Box, name: string) {
		const fake = createFakeDiscovery()
		const joiner = await box(
			{ hub: createDiscoveryHub(), clock: world.clock },
			name,
			'builder',
			{},
			() => fake,
		)
		const summary = await a.rt.control.summary()
		fake.emitFound({
			netId: (summary.machine?.id ?? '').slice(0, 16),
			host: '127.0.0.1',
			port: summary.port as number,
		})
		world.clock.advance(60_000)
		world.clock.advance(BROWSE_WINDOW_MS)
		return joiner
	}

	it('the first Allow can trust the network; the next machine on it joins with one line and no Allow', async () => {
		const { world, a } = await founder()
		const b = await ask(world, a, 'desk-linux')
		await a.until((e) => e.type === 'join-request')
		const before = await a.rt.control.summary()
		expect(before.joinRequests[0]?.trustOffer).toEqual({ suggestedName: 'Network 1' })
		const joined = b.until((e) => e.type === 'joined')
		await a.rt.control.allow(before.joinRequests[0]?.requestId as string, { trust: 'Home' })
		await joined
		expect((await a.rt.control.networks()).map((n) => n.name)).toEqual(['Home'])

		const c = await ask(world, a, 'mini-pc')
		await c.until((e) => e.type === 'joined')
		await a.rt.refresh()
		const line = a.notices.find((n) =>
			n.includes('mini-pc joined your Namzu network automatically'),
		)
		expect(line).toContain('(trusted network Home)')
		expect(line).toContain('namzu peers untrust Home')
		const after = await a.rt.control.summary()
		expect(after.joinRequests).toEqual([])
		expect(after.autoJoined.map((j) => j.name)).toEqual(['mini-pc'])
		expect(after.members).toBe(3)
		const audit = readFileSync(join(a.home, 'network', 'audit.jsonl'), 'utf8')
		expect(audit).toContain('automatically (trusted network Home)')

		await a.rt.control.untrust('home')
		expect(await a.rt.control.networks()).toEqual([])
	})

	it('autoAdmit never keeps asking on a trusted network', async () => {
		const { world, a } = await founder('never')
		const b = await ask(world, a, 'desk-linux')
		await a.until((e) => e.type === 'join-request')
		const first = await a.rt.control.summary()
		await a.rt.control.allow(first.joinRequests[0]?.requestId as string, { trust: true })
		await b.until((e) => e.type === 'joined')
		expect(await a.rt.control.networks()).toHaveLength(1)
		const c = await ask(world, a, 'mini-pc')
		await a.until((e) => e.type === 'join-request' && e.request.name === 'mini-pc')
		expect((await a.rt.control.summary()).joinRequests.map((j) => j.name)).toEqual(['mini-pc'])
		expect(c.notices.join('\n')).not.toContain('joined')
	})
})
