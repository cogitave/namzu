import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import {
	BROWSE_WINDOW_MS,
	HOLD_EXPIRY_MS,
	type NetworkEvent,
	createDiscoveryHub,
	createManualClock,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
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
	settings: { acceptMail?: 'members' | 'hold' | 'off' } = {},
): Promise<Box> {
	const root = mkdtempSync(join(tmpdir(), 'nr-'))
	roots.push(root)
	const home = join(root, 'h')
	const cwd = join(root, name)
	mkdirSync(cwd, { recursive: true })
	const notices: string[] = []
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
		settings: { enabled: 'auto', acceptMail: settings.acceptMail ?? 'members', machineName: name },
		interactive: true,
		notify: (text) => notices.push(text),
		ownRef: () => own.ref,
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		discovery: () => world.hub.create(),
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
		network: () => (rt.decision.run ? rt.link : undefined),
	})
	sessions.push(session)
	own.ref = session.ref
	return {
		name,
		home,
		rt,
		notices,
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
		const context = b.session.takeRoleContext()
		const text = String(context?.content)
		expect(text).toContain('you will build the parser')
		expect(text).toContain('grants no permission')
		expect(text).toContain('does not change your permission mode')
		// Said once; the mode and the inbox are untouched by it.
		expect(b.session.takeRoleContext()).toBeUndefined()
		expect(b.session.pending).toBe(0)
		// After a compaction the line is put back in front of the model.
		b.session.rearmRole()
		expect(b.session.takeRoleContext()).toBeDefined()
		// Cleared from the other side.
		expect((await a.rt.control.setRole('desk-linux/builder', null)).status).toBe('applied')
		expect(String(b.session.takeRoleContext()?.content)).toContain('No role is set now')
		expect(b.session.role).toBeUndefined()
	})

	it('a machine removed from any member is refused afterwards and told so', async () => {
		const { a, b } = await pair()
		const gone = b.until((e) => e.type === 'removed-self')
		const removed = await a.rt.control.remove('desk-linux')
		expect(removed.removed).toEqual(['desk-linux'])
		await gone
		expect(await a.session.send('desk-linux/builder', 'still there?')).toMatchObject({
			status: 'refused',
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
			settings: { enabled: 'auto', acceptMail: 'members' },
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
