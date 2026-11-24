import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { createMemoryAuditSink } from './audit.js'
import { type ManualClock, createManualClock } from './clock.js'
import { type NetworkDiscovery, createDiscoveryHub, createFakeDiscovery } from './discovery.js'
import { generateMachineKey } from './identity.js'
import {
	JOIN_ADDRESS_WINDOW_MS,
	JOIN_BACKOFF_DENIED_MS,
	JOIN_BACKOFF_OTHER_MS,
	JOIN_EXPIRY_MS,
} from './join.js'
import { HOLD_EXPIRY_MS } from './mail-policy.js'
import type { LocalSession } from './roster.js'
import {
	FRESH_NETWORK_MS,
	type NetworkEvent,
	type NetworkHost,
	type NetworkService,
	type NetworkServiceOptions,
	type RemoteMail,
	createNamzuNetwork,
	parseHostPort,
} from './service.js'
import { NetworkError, dialNet } from './transport.js'
import { NET_PROTOCOL } from './wire.js'
import { buildMachineCertificate } from './x509.js'

const homes: string[] = []
const services: NetworkService[] = []
afterEach(async () => {
	for (const s of services.splice(0)) await s.close()
	for (const h of homes.splice(0)) removeTempDir(h)
})

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

function session(
	ref: string,
	name: string,
	mode = 'auto',
	extra: Partial<LocalSession> = {},
): LocalSession {
	return {
		ref,
		name,
		folder: 'proj',
		state: 'idle',
		mode,
		acceptsMessages: true,
		kind: 'tui',
		...extra,
	}
}

interface Machine {
	readonly name: string
	readonly svc: NetworkService
	readonly home: string
	readonly sessions: LocalSession[]
	readonly delivered: { ref: string; mail: RemoteMail }[]
	readonly roles: { ref: string; role: string | null }[]
	readonly events: NetworkEvent[]
	until(match: (e: NetworkEvent) => boolean): Promise<NetworkEvent>
	/** Ignore events seen so far: later `until` calls look only at what happens next. */
	fresh(): void
	addr(): { host: string; port: number }
}

function machine(
	name: string,
	world: { hub: ReturnType<typeof createDiscoveryHub>; clock: ManualClock },
	sessions: LocalSession[] = [],
	discovery?: NetworkDiscovery,
	extra: Partial<NetworkServiceOptions> = {},
): Machine {
	const home = mkdtempSync(join(tmpdir(), 'namzu-net-svc-'))
	homes.push(home)
	const delivered: Machine['delivered'] = []
	const roles: Machine['roles'] = []
	const events: NetworkEvent[] = []
	const host: NetworkHost = {
		listLocalSessions: () => sessions,
		async deliverLocal(ref, mail) {
			delivered.push({ ref, mail })
			return { status: 'queued' }
		},
		setLocalRole(ref, role) {
			const s = sessions.find((x) => x.ref === ref)
			if (!s) return false
			roles.push({ ref, role })
			const i = sessions.indexOf(s)
			sessions[i] = { ...s, role: role ?? undefined }
			return true
		},
	}
	const svc = createNamzuNetwork({
		home,
		host,
		interactive: true,
		discovery: discovery ?? world.hub.create(),
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		listenPort: 0,
		hostname: name,
		// never read the real gateway from a test
		networkIdentity: async () => undefined,
		...extra,
	})
	services.push(svc)
	let cutoff = 0
	const waiters: Array<{
		match: (e: NetworkEvent) => boolean
		resolve: (e: NetworkEvent) => void
	}> = []
	svc.on((e) => {
		events.push(e)
		for (const w of [...waiters])
			if (w.match(e)) {
				waiters.splice(waiters.indexOf(w), 1)
				w.resolve(e)
			}
	})
	return {
		name,
		svc,
		home,
		sessions,
		delivered,
		roles,
		events,
		fresh: () => {
			cutoff = events.length
		},
		until: (match) => {
			const past = events.slice(cutoff).find(match)
			if (past) return Promise.resolve(past)
			return new Promise((resolve) => waiters.push({ match, resolve }))
		},
		addr: () => ({ host: '127.0.0.1', port: svc.status().port as number }),
	}
}

const newWorld = () => ({ hub: createDiscoveryHub(), clock: createManualClock() })

async function found(m: Machine, clock: ManualClock) {
	await m.svc.start()
	clock.advance(5000)
	await m.until((e) => e.type === 'founded')
}

/** Start `joiner`, let it find the network, and allow it on `allower` (which may not be the machine it asked). */
async function admit(joiner: Machine, allower: Machine, clock: ManualClock) {
	// every machine here asks from 127.0.0.1; a member refuses one address twice inside a minute
	clock.advance(JOIN_ADDRESS_WINDOW_MS)
	for (const m of [joiner, allower]) m.fresh()
	await joiner.svc.start()
	clock.advance(5000)
	const waiting = await joiner.until((e) => e.type === 'join-waiting')
	const request = await allower.until((e) => e.type === 'join-request')
	await allower.svc.allow((request as Extract<NetworkEvent, { type: 'join-request' }>).request.code)
	await joiner.until((e) => e.type === 'joined')
	return waiting as Extract<NetworkEvent, { type: 'join-waiting' }>
}

async function mesh(a: Machine, b: Machine) {
	await a.svc.add(`127.0.0.1:${b.addr().port}`)
	await b.svc.add(`127.0.0.1:${a.addr().port}`)
}

async function trio() {
	const world = newWorld()
	const a = machine('studio', world, [session('aaaaaa', 'calm-heron')])
	const b = machine('desk', world, [
		session('bbbbbb', 'swift-finch'),
		session('b2b2b2', 'quiet-otter', 'prompt'),
	])
	const c = machine('mini', world, [session('cccccc', 'brisk-marten')])
	await found(a, world.clock)
	await admit(b, a, world.clock)
	await mesh(a, b)
	for (const m of [a, b, c]) m.fresh()
	return { world, a, b, c }
}

describe('creating and joining a network', () => {
	it('refuses to run unattended and leaves nothing behind on a network it cannot call private', async () => {
		const world = newWorld()
		expect(() =>
			createNamzuNetwork({
				home: tmpdir(),
				host: { listLocalSessions: () => [], deliverLocal: async () => ({ status: 'refused' }) },
				interactive: false,
				discovery: world.hub.create(),
			}),
		).toThrow(NetworkError)
		const home = mkdtempSync(join(tmpdir(), 'namzu-net-off-'))
		homes.push(home)
		const svc = createNamzuNetwork({
			home,
			host: { listLocalSessions: () => [], deliverLocal: async () => ({ status: 'refused' }) },
			interactive: true,
			discovery: world.hub.create(),
			clock: world.clock,
			interfaces: () => ({
				eth0: [
					{
						address: '8.8.8.8',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '',
						internal: false,
						cidr: null,
					},
				],
			}),
		})
		services.push(svc)
		await svc.start()
		expect(svc.status().state).toBe('off')
		expect(readdirSync(home)).toEqual([])
	})

	it('founds a network when nothing is nearby, with private files and a key that never leaves them', async () => {
		const world = newWorld()
		const a = machine('studio', world)
		await found(a, world.clock)
		expect(a.svc.status()).toMatchObject({ state: 'ready', members: 1 })
		const dir = join(a.home, 'network')
		if (process.platform !== 'win32') {
			expect(statSync(dir).mode & 0o777).toBe(0o700)
			for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
		}
		const everything = readdirSync(dir)
			.filter((f) => f !== 'machine.key.pem')
			.map((f) => readFileSync(join(dir, f), 'utf8'))
			.join('\n')
		expect(everything).not.toContain('PRIVATE KEY')
	})

	it('shows the same short code on both screens and admits after one Allow on a machine the joiner never asked', async () => {
		const { world, a, b, c } = await trio()
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		await c.svc.start()
		world.clock.advance(5000)
		const waiting = (await c.until((e) => e.type === 'join-waiting')) as Extract<
			NetworkEvent,
			{ type: 'join-waiting' }
		>
		const onB = (await b.until((e) => e.type === 'join-request')) as Extract<
			NetworkEvent,
			{ type: 'join-request' }
		>
		const onA = (await a.until((e) => e.type === 'join-request')) as Extract<
			NetworkEvent,
			{ type: 'join-request' }
		>
		expect(onB.request.code).toBe(waiting.code)
		expect(onA.request.code).toBe(waiting.code)
		expect(onB.request.name).toBe('mini')
		expect(c.svc.status().members).toBe(0)
		await b.svc.allow(waiting.shownCode)
		await c.until((e) => e.type === 'joined')
		expect(
			c.svc
				.members()
				.map((m) => m.name)
				.sort(),
		).toEqual(['desk', 'mini', 'studio'])
		expect(c.svc.status().state).toBe('ready')
		expect(b.svc.admittedBy(b.svc.identity()?.machineId as string)).toEqual([
			c.svc.identity()?.machineId,
		])
		expect(a.svc.pendingJoins()).toEqual([])
		await b.until((e) => e.type === 'join-settled' && e.result === 'allow')
		// The member the joiner reached shows it by the name it gave, before the joiner's own greeting arrives.
		const reached = onB.request.local ? b : a
		expect(reached.svc.members().map((m) => m.name)).toContain('mini')
	})

	it('two machines started together end up in one network after one Allow, with nothing typed', async () => {
		const world = newWorld()
		const a = machine('studio', world, [session('aaaaaa', 'calm-heron')])
		const b = machine('desk', world, [session('bbbbbb', 'swift-finch')])
		await a.svc.start()
		await b.svc.start()
		// both browsed for the whole window and heard nothing, so both founded their own network
		world.clock.advance(5000)
		await a.until((e) => e.type === 'founded')
		await b.until((e) => e.type === 'founded')
		const netA = a.svc.status().netId
		const netB = b.svc.status().netId
		expect(netA).not.toBe(netB)
		// the one that is younger (by its own clock) is the one that asks; the other only gets a request
		const requestOn = await Promise.race([
			a.until((e) => e.type === 'join-request').then((e) => ({ older: a, younger: b, e })),
			b.until((e) => e.type === 'join-request').then((e) => ({ older: b, younger: a, e })),
		])
		const request = (requestOn.e as Extract<NetworkEvent, { type: 'join-request' }>).request
		const waiting = (await requestOn.younger.until((e) => e.type === 'join-waiting')) as Extract<
			NetworkEvent,
			{ type: 'join-waiting' }
		>
		expect(waiting.code).toBe(request.code)
		expect(requestOn.younger.svc.status().members).toBe(1)
		await requestOn.older.svc.allow(request.code)
		await requestOn.younger.until((e) => e.type === 'joined')
		expect(requestOn.younger.svc.status().netId).toBe(requestOn.older.svc.status().netId)
		expect(requestOn.older.svc.status().members).toBe(2)
	})

	it('a machine that has been alone for a long time does not step down for a new one', async () => {
		const world = newWorld()
		const a = machine('studio', world)
		await found(a, world.clock)
		world.clock.advance(FRESH_NETWORK_MS + 1000)
		const b = machine('desk', world)
		await b.svc.start()
		world.clock.advance(5000)
		// b browsed, heard a's network and asked to join it; a never asks anything
		await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-waiting')).toBe(false)
		expect(b.events.some((e) => e.type === 'founded')).toBe(false)
	})

	it('a person can cancel the request a machine is waiting on', async () => {
		const world = newWorld()
		const a = machine('studio', world)
		await found(a, world.clock)
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		const b = machine('desk', world)
		expect(b.svc.cancelJoin()).toBe(false)
		await b.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'join-waiting')
		await a.until((e) => e.type === 'join-request')
		expect(b.svc.cancelJoin()).toBe(true)
		await b.until((e) => e.type === 'join-ended')
		expect(b.events.find((e) => e.type === 'join-ended')).toMatchObject({ result: 'cancelled' })
		await a.until((e) => e.type === 'join-settled')
		expect(a.svc.pendingJoins()).toEqual([])
		expect(b.svc.status().members).toBe(0)
	})

	it('hears two networks nearby: asks neither and offers one address for each', async () => {
		const world = newWorld()
		const other = newWorld()
		const a = machine('studio', world)
		const b = machine('desk', other)
		await found(a, world.clock)
		await found(b, other.clock)
		const fake = createFakeDiscovery()
		const c = machine('mini', world, [], fake)
		await c.svc.start()
		const addrA = { netId: a.svc.status().netId as string, host: '127.0.0.1', port: a.addr().port }
		const addrB = { netId: b.svc.status().netId as string, host: '127.0.0.1', port: b.addr().port }
		fake.emitFound(addrA)
		fake.emitFound(addrB)
		world.clock.advance(5000)
		await c.until((e) => e.type === 'state' && e.state === 'ambiguous')
		expect(c.events.some((e) => e.type === 'join-waiting')).toBe(false)
		expect(a.svc.pendingJoins()).toEqual([])
		expect(b.svc.pendingJoins()).toEqual([])
		expect(
			c.svc
				.nearbyNetworks()
				.map((n) => n.port)
				.sort(),
		).toEqual([addrA.port, addrB.port].sort())
		// choosing one is a single join call
		const choice = c.svc.nearbyNetworks().find((n) => n.port === addrB.port) as {
			host: string
			port: number
		}
		void c.svc.join({ host: choice.host, port: choice.port }).catch(() => undefined)
		await b.until((e) => e.type === 'join-request')
		expect(a.svc.pendingJoins()).toEqual([])
	})

	it('does not join without an Allow, and a second decision is refused', async () => {
		const { world, a, b, c } = await trio()
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		await c.svc.start()
		world.clock.advance(5000)
		const request = (await a.until((e) => e.type === 'join-request')) as Extract<
			NetworkEvent,
			{ type: 'join-request' }
		>
		expect(c.svc.members()).toHaveLength(0)
		await a.svc.deny(request.request.code)
		await c.until((e) => e.type === 'join-ended')
		expect(c.events.find((e) => e.type === 'join-ended')).toMatchObject({ result: 'denied' })
		expect(c.svc.members()).toHaveLength(0)
		await expect(b.svc.allow(request.request.code)).rejects.toBeInstanceOf(NetworkError)
	})

	it('lets a person approve from any member: an unanswered request expires on every machine', async () => {
		const { world, a, b, c } = await trio()
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		await c.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'join-request')
		world.clock.advance(10 * 60 * 1000)
		await c.until((e) => e.type === 'join-ended')
		expect(c.events.find((e) => e.type === 'join-ended')).toMatchObject({ result: 'expired' })
		expect(a.svc.pendingJoins()).toEqual([])
		expect(b.svc.pendingJoins()).toEqual([])
	})
})

describe('what a stranger can do', () => {
	it('learns only the network fingerprint: the advertisement has no names and a non-member can only ask to join', async () => {
		const { a, b } = await trio()
		const key = generateMachineKey()
		const identity = { key, certificatePem: buildMachineCertificate(key).pem }
		const clock = createManualClock()
		const client = await dialNet({ identity, host: '127.0.0.1', port: a.addr().port, clock })
		const reply = (await client.request({ protocol: NET_PROTOCOL, op: 'ping_net' })) as {
			ok: boolean
			netId: string
		}
		expect(reply.ok).toBe(true)
		expect(JSON.stringify(reply)).not.toContain('studio')
		expect(reply.netId).toHaveLength(16)
		const second = await dialNet({ identity, host: '127.0.0.1', port: a.addr().port, clock })
		await expect(second.request({ protocol: NET_PROTOCOL, op: 'roster' })).rejects.toBeInstanceOf(
			NetworkError,
		)
		const third = await dialNet({ identity, host: '127.0.0.1', port: b.addr().port, clock })
		await expect(
			third.request({
				protocol: NET_PROTOCOL,
				op: 'net_deliver',
				id: 'x',
				to: { sessionRef: 'aaaaaa' },
				from: { sessionRef: 'cccccc', sessionName: 'x', mode: 'auto', kind: 'tui' },
				text: 'hi',
				hops: 0,
			}),
		).rejects.toBeInstanceOf(NetworkError)
		expect(b.delivered).toEqual([])
		client.close()
	})

	it('closes the connection on an oversize first line and caps connections per address', async () => {
		const { a } = await trio()
		const key = generateMachineKey()
		const identity = { key, certificatePem: buildMachineCertificate(key).pem }
		const clock = createManualClock()
		const big = await dialNet({ identity, host: '127.0.0.1', port: a.addr().port, clock })
		await expect(
			big.request({ protocol: NET_PROTOCOL, op: 'ping_net', pad: 'x'.repeat(5000) }),
		).rejects.toBeInstanceOf(NetworkError)
		const clients = []
		for (let i = 0; i < 5; i++)
			clients.push(await dialNet({ identity, host: '127.0.0.1', port: a.addr().port, clock }))
		await expect(clients[4]?.nextFrame()).rejects.toBeInstanceOf(NetworkError)
		for (const c of clients) c.close()
	})

	it('records refused connections in the audit log without a name or text', async () => {
		const { a } = await trio()
		const key = generateMachineKey()
		const identity = { key, certificatePem: buildMachineCertificate(key).pem }
		const c = await dialNet({
			identity,
			host: '127.0.0.1',
			port: a.addr().port,
			clock: createManualClock(),
		})
		await expect(c.request({ protocol: NET_PROTOCOL, op: 'roster' })).rejects.toBeInstanceOf(
			NetworkError,
		)
		await a.svc.close()
		const log = readFileSync(join(a.home, 'network', 'audit.jsonl'), 'utf8')
		expect(log).toContain('connection_refused')
		expect(log).toContain('not_member:roster')
	})
})

describe('removing a machine', () => {
	it('refuses a removed member, tells the others, and resets the removed machine', async () => {
		const { world, a, b, c } = await trio()
		await admit(c, b, world.clock)
		await mesh(a, c)
		await mesh(b, c)
		const cId = c.svc.identity()?.machineId as string
		const oldKeyFile = readFileSync(join(c.home, 'network', 'machine.key.pem'), 'utf8')
		const result = await a.svc.remove(cId)
		expect(result.removed).toEqual([cId])
		await c.until((e) => e.type === 'removed-self')
		await b.until((e) => e.type === 'member-removed')
		expect(existsSync(join(c.home, 'network', 'machine.key.pem'))).toBe(false)
		expect(b.svc.members().map((m) => m.machineId)).not.toContain(cId)
		expect(c.svc.status().state).toBe('removed')
		// the removed key can no longer use the network
		await expect(
			a.svc.send({ machineId: cId, sessionRef: 'cccccc' }, 'hi', {
				sessionRef: 'aaaaaa',
				sessionName: 'calm-heron',
				mode: 'auto',
			}),
		).rejects.toBeInstanceOf(NetworkError)
		await c.svc.start()
		expect(readFileSync(join(c.home, 'network', 'machine.key.pem'), 'utf8')).not.toBe(oldKeyFile)
		expect(c.svc.identity()?.machineId).not.toBe(cId)
	})

	it('can remove a member together with the machines it admitted', async () => {
		const { world, a, b, c } = await trio()
		await admit(c, b, world.clock)
		const bId = b.svc.identity()?.machineId as string
		// Read before the removal: a removed machine may drop its identity as soon as it hears of it.
		const cId = c.svc.identity()?.machineId as string
		expect(a.svc.admittedBy(bId)).toEqual([cId])
		const result = await a.svc.remove(bId, { cascade: true })
		expect([...result.removed].sort()).toEqual([bId, cId].sort())
	})
})

describe('roster', () => {
	it('lists every machine with its sessions and shows a silent one offline with its last sessions', async () => {
		const { a, b } = await trio()
		const view = await a.svc.roster()
		expect(view.machines.map((m) => [m.name, m.status])).toEqual([
			['studio', 'self'],
			['desk', 'online'],
		])
		expect(view.machines[1]?.sessions.map((s) => s.name)).toEqual(['swift-finch', 'quiet-otter'])
		expect(JSON.stringify(view)).not.toContain('/home')
		await b.svc.close()
		const later = await a.svc.roster()
		expect(later.machines[1]).toMatchObject({ name: 'desk', status: 'offline' })
		expect(later.machines[1]?.sessions).toHaveLength(2)
	})

	it('renames a machine and the others see the new name', async () => {
		const { a, b } = await trio()
		await b.svc.rename('workshop')
		await a.svc.roster()
		expect((await a.svc.roster()).machines[1]?.name).toBe('workshop')
	})
})

describe('roles', () => {
	it('sets a session role from another machine without touching its permission mode or its mail', async () => {
		const { a, b } = await trio()
		const before = b.sessions.map((s) => s.mode)
		const reply = await a.svc.setRole(
			{ machineId: b.svc.identity()?.machineId as string, sessionRef: 'bbbbbb' },
			'you will build the parser',
		)
		expect(reply.status).toBe('applied')
		expect(b.roles).toEqual([{ ref: 'bbbbbb', role: 'you will build the parser' }])
		expect(b.sessions.map((s) => s.mode)).toEqual(before)
		expect(b.delivered).toEqual([])
		expect(b.svc.held()).toEqual([])
		const view = await a.svc.roster()
		expect(view.machines[1]?.sessions[0]?.role).toBe('you will build the parser')
		await a.svc.setRole({ machineId: b.svc.identity()?.machineId as string }, 'orchestrator')
		expect((await a.svc.roster()).machines[1]?.role).toBe('orchestrator')
	})

	it('refuses an unknown session, truncates an over-long role to 500 bytes, and rate-limits', async () => {
		const { a, b } = await trio()
		const bId = b.svc.identity()?.machineId as string
		expect((await a.svc.setRole({ machineId: bId, sessionRef: 'ffffff' }, 'x')).status).toBe(
			'refused',
		)
		await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, 'é'.repeat(400))
		expect(Buffer.byteLength(b.roles.at(-1)?.role ?? '')).toBeLessThanOrEqual(500)
		const outcomes = []
		for (let i = 0; i < 8; i++)
			outcomes.push((await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, `r${i}`)).status)
		expect(outcomes).toContain('refused')
	})

	it('does not set a role on a session that skips approvals when it comes from another machine', async () => {
		const { a, b } = await trio()
		b.sessions[0] = { ...(b.sessions[0] as LocalSession), mode: 'bypass', bypass: true }
		const bId = b.svc.identity()?.machineId as string
		const reply = await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, 'orchestrator')
		expect(reply.status).toBe('refused')
		expect(b.roles).toEqual([])
	})

	it('shows a roster from another machine without control characters', async () => {
		const { a, b } = await trio()
		b.sessions[0] = {
			...(b.sessions[0] as LocalSession),
			name: 'calm\u001b]52;c;x\u0007 heron',
			folder: 'pro\u001b[2Jj',
			role: 'do\u001b[31m this',
		}
		const view = await a.svc.roster()
		const row = view.machines[1]?.sessions[0]
		for (const text of [row?.name, row?.folder, row?.role])
			expect(
				[...(text ?? '')].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127),
			).toBe(false)
	})

	it('clears a role with null', async () => {
		const { a, b } = await trio()
		const bId = b.svc.identity()?.machineId as string
		await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, 'orchestrator')
		await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, null)
		expect(b.roles.at(-1)).toEqual({ ref: 'bbbbbb', role: null })
	})
})

describe('mail between machines', () => {
	const from = { sessionRef: 'aaaaaa', sessionName: 'calm-heron', mode: 'auto' }
	const toB = (svc: NetworkService, ref = 'bbbbbb') => ({
		machineId: svc.members().find((m) => !m.self)?.machineId as string,
		sessionRef: ref,
	})

	it('delivers into a terminal in the same mode and names the sending machine', async () => {
		const { a, b } = await trio()
		const result = await a.svc.send(toB(a.svc), 'please run the check', from)
		expect(result.status).toBe('queued')
		expect(b.delivered).toHaveLength(1)
		expect(b.delivered[0]?.mail).toMatchObject({
			text: 'please run the check',
			allowedOnce: false,
			from: { machineName: 'studio', sessionName: 'calm-heron', mode: 'auto' },
		})
	})

	it('holds a different mode for the person, tells the sender, and queues it on allow', async () => {
		const { a, b } = await trio()
		const result = await a.svc.send(toB(a.svc, 'b2b2b2'), 'rerun the migration check', from)
		expect(result.status).toBe('held')
		expect(result.reason).toContain('differs')
		expect(b.delivered).toEqual([])
		const held = b.svc.held()
		expect(held).toHaveLength(1)
		expect(held[0]).toMatchObject({ machineName: 'studio', fromSessionName: 'calm-heron' })
		await b.svc.allowHeld(held[0]?.id as string)
		const outcome = (await a.until(
			(e) => e.type === 'mail-outcome' && e.outcome === 'queued',
		)) as Extract<NetworkEvent, { type: 'mail-outcome' }>
		expect(outcome.id).toBe(result.id)
		expect(b.delivered[0]?.mail.allowedOnce).toBe(true)
		expect(b.svc.held()).toEqual([])
	})

	it('refuses on deny and tells the sender', async () => {
		const { a, b } = await trio()
		await a.svc.send(toB(a.svc, 'b2b2b2'), 'hello', from)
		await b.svc.denyHeld(b.svc.held()[0]?.id as string)
		await a.until((e) => e.type === 'mail-outcome' && e.outcome === 'refused')
		expect(b.delivered).toEqual([])
	})

	it('expires held mail after ten minutes and tells the sender', async () => {
		const { world, a, b } = await trio()
		const sent = await a.svc.send(toB(a.svc, 'b2b2b2'), 'anyone there?', from)
		world.clock.advance(HOLD_EXPIRY_MS - 1)
		expect(b.svc.held()).toHaveLength(1)
		world.clock.advance(1)
		const outcome = (await a.until(
			(e) => e.type === 'mail-outcome' && e.outcome === 'expired',
		)) as Extract<NetworkEvent, { type: 'mail-outcome' }>
		expect(outcome.id).toBe(sent.id)
		expect(b.svc.held()).toEqual([])
		expect(b.delivered).toEqual([])
	})

	it('holds when the sender claims a mode its own machine does not report', async () => {
		const { a, b } = await trio()
		const result = await a.svc.send(toB(a.svc), 'trust me', { ...from, mode: 'prompt' })
		expect(result.status).toBe('held')
		expect(b.delivered).toEqual([])
	})

	it('holds every message for a terminal in bypass mode, even in the same mode', async () => {
		const { a, b } = await trio()
		b.sessions[0] = session('bbbbbb', 'swift-finch', 'auto', { bypass: true })
		const result = await a.svc.send(toB(a.svc), 'hi', from)
		expect(result.status).toBe('held')
	})

	it('holds when mail from a session the roster does not list cannot be confirmed', async () => {
		const { a, b } = await trio()
		const result = await a.svc.send(toB(a.svc), 'hi', { ...from, sessionRef: 'dddddd' })
		expect(result.status).toBe('held')
		expect(b.delivered).toEqual([])
	})

	it('refuses an unknown session, an empty message and a terminal that takes none', async () => {
		const { a, b } = await trio()
		expect((await a.svc.send(toB(a.svc, 'ffffff'), 'hi', from)).status).toBe('refused')
		await expect(a.svc.send(toB(a.svc), '   ', from)).rejects.toBeInstanceOf(NetworkError)
		b.sessions[0] = session('bbbbbb', 'swift-finch', 'auto', { acceptsMessages: false })
		expect((await a.svc.send(toB(a.svc), 'hi', from)).status).toBe('refused')
	})

	it('rate-limits one sending machine', async () => {
		const { a } = await trio()
		const statuses: string[] = []
		for (let i = 0; i < 34; i++) statuses.push((await a.svc.send(toB(a.svc), `m${i}`, from)).status)
		expect(statuses.filter((s) => s === 'refused').length).toBeGreaterThan(0)
	})

	it('never writes message text or key bytes to the audit log', async () => {
		const { a, b } = await trio()
		const secret = 'the vault code is 4471'
		await a.svc.send(toB(a.svc), secret, from)
		await a.svc.send(toB(a.svc, 'b2b2b2'), `${secret} again`, from)
		const privateKey = readFileSync(join(b.home, 'network', 'machine.key.pem'), 'utf8')
		await a.svc.close()
		await b.svc.close()
		for (const m of [a, b]) {
			const log = readFileSync(join(m.home, 'network', 'audit.jsonl'), 'utf8')
			expect(log).not.toContain('vault code')
			expect(log).not.toContain('PRIVATE')
			expect(log).not.toContain(privateKey.split('\n')[1] as string)
			for (const line of log.trim().split('\n')) JSON.parse(line)
		}
		expect(readFileSync(join(b.home, 'network', 'audit.jsonl'), 'utf8')).toContain('mail_held')
	})
})

describe('the audit log records every role change and mail decision, on both machines, without text', () => {
	const from = { sessionRef: 'aaaaaa', sessionName: 'calm-heron', mode: 'auto' }
	it('writes who, what, direction and a hash for roles and for each outcome of a message', async () => {
		const { world, a, b } = await trio()
		const bId = b.svc.identity()?.machineId as string
		const role = 'reviews the parser changes'
		await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, role)
		await a.svc.setRole({ machineId: bId, sessionRef: 'bbbbbb' }, null)
		const to = (ref: string) => ({ machineId: bId, sessionRef: ref })
		await a.svc.send(to('bbbbbb'), 'accepted words', from)
		await a.svc.send(to('b2b2b2'), 'allowed words', from)
		await a.svc.send(to('b2b2b2'), 'denied words', from)
		await a.svc.send(to('b2b2b2'), 'expired words', from)
		await a.svc.send(to('ffffff'), 'refused words', from)
		const held = b.svc.held()
		expect(held).toHaveLength(3)
		await b.svc.allowHeld(held[0]?.id as string)
		await b.svc.denyHeld(held[1]?.id as string)
		world.clock.advance(HOLD_EXPIRY_MS)
		await a.until((e) => e.type === 'mail-outcome' && e.outcome === 'expired')
		await a.svc.close()
		await b.svc.close()
		const read = (m: Machine) =>
			readFileSync(join(m.home, 'network', 'audit.jsonl'), 'utf8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l) as Record<string, unknown>)
		for (const m of [a, b]) {
			const text = readFileSync(join(m.home, 'network', 'audit.jsonl'), 'utf8')
			for (const word of [
				'parser',
				'accepted words',
				'allowed words',
				'denied words',
				'expired words',
			])
				expect(text).not.toContain(word)
		}
		const onA = read(a)
		const onB = read(b)
		const roleOut = onA.filter((e) => e.event === 'role_set')
		expect(roleOut).toHaveLength(2)
		expect(roleOut[0]).toMatchObject({ direction: 'out', session: 'bbbbbb', decision: 'set' })
		expect(typeof roleOut[0]?.textHash).toBe('string')
		expect(roleOut[1]).toMatchObject({ decision: 'clear' })
		expect(onB.filter((e) => e.event === 'role_set' && e.direction === 'in')).toHaveLength(2)
		const kinds = (log: Record<string, unknown>[], direction: string) =>
			new Set(log.filter((e) => e.direction === direction).map((e) => e.event))
		for (const k of [
			'mail_accepted',
			'mail_held',
			'mail_allowed',
			'mail_denied',
			'mail_expired',
			'mail_refused',
		])
			expect(kinds(onB, 'in'), `receiver ${k}`).toContain(k)
		for (const k of [
			'mail_accepted',
			'mail_held',
			'mail_allowed',
			'mail_denied',
			'mail_expired',
			'mail_refused',
		])
			expect(kinds(onA, 'out'), `sender ${k}`).toContain(k)
	})
})

describe('manual addresses', () => {
	it('parses host, host:port and bracketed IPv6 and rejects junk', () => {
		expect(parseHostPort('192.168.1.5')).toEqual({ host: '192.168.1.5', port: 47310 })
		expect(parseHostPort('desk.local:5000')).toEqual({ host: 'desk.local', port: 5000 })
		expect(parseHostPort('[fe80::1]:6000')).toEqual({ host: 'fe80::1', port: 6000 })
		expect(() => parseHostPort('bad host')).toThrow(NetworkError)
		expect(() => parseHostPort('x:99999')).toThrow(NetworkError)
	})
})

describe('trusted networks', () => {
	const HOME_NET = 'a1b2c3d4e5f60718'

	/** a founds; the joiner asks it; `allow` decides on a. Returns the audit entries of a. */
	async function setup(extraA: Partial<NetworkServiceOptions> = {}) {
		const world = newWorld()
		const audit = createMemoryAuditSink()
		const a = machine('studio', world, [session('aaaaaa', 'calm-heron')], undefined, {
			networkIdentity: async () => HOME_NET,
			audit,
			...extraA,
		})
		await found(a, world.clock)
		return { world, a, audit }
	}

	async function ask(world: ReturnType<typeof newWorld>, joiner: Machine, on: Machine) {
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		for (const m of [joiner, on]) m.fresh()
		await joiner.svc.start()
		world.clock.advance(5000)
		await joiner.until((e) => e.type === 'join-waiting')
	}

	it('the first Allow with trust marks the network, and the next machine on it joins without asking', async () => {
		const { world, a, audit } = await setup()
		const b = machine('desk', world, [session('bbbbbb', 'swift-finch')], undefined, {
			networkIdentity: async () => HOME_NET,
			audit,
		})
		await ask(world, b, a)
		const request = (await a.until((e) => e.type === 'join-request')) as Extract<
			NetworkEvent,
			{ type: 'join-request' }
		>
		await expect(a.svc.networkOf(request.request.sourceAddr)).resolves.toEqual({
			id: HOME_NET,
			suggestedName: 'Network 1',
		})
		await a.svc.allow(request.request.code, { trust: 'Home' })
		await b.until((e) => e.type === 'joined')
		expect((await a.svc.trustedNetworks()).map((n) => n.name)).toEqual(['Home'])
		expect(a.svc.pendingJoins()).toEqual([])

		const c = machine('mini', world, [session('cccccc', 'brisk-marten')])
		await b.svc.trustNetwork('127.0.0.1', 'Home')
		a.fresh()
		await ask(world, c, a)
		await c.until((e) => e.type === 'joined')
		const auto =
			a.events.find((e) => e.type === 'join-auto') ?? b.events.find((e) => e.type === 'join-auto')
		expect(auto).toMatchObject({
			type: 'join-auto',
			name: 'mini',
			mode: 'trusted-network',
			network: 'Home',
		})
		expect(a.events.some((e) => e.type === 'join-request' && e.request.name === 'mini')).toBe(false)
		expect(
			c.svc
				.members()
				.map((m) => m.name)
				.sort(),
		).toEqual(['desk', 'mini', 'studio'])
		const line = audit.entries.find((e) => e.event === 'join_allowed' && e.machine?.name === 'mini')
		expect(line?.decision).toBe('automatically (trusted network Home)')
		expect(audit.entries.some((e) => e.event === 'network_trusted' && e.reason === 'Home')).toBe(
			true,
		)
	})

	it('a network that is not trusted keeps asking, also after an Allow without trust', async () => {
		const { world, a } = await setup()
		const b = machine('desk', world, [])
		await admit(b, a, world.clock)
		expect(await a.svc.trustedNetworks()).toEqual([])
		const c = machine('mini', world, [])
		await ask(world, c, a)
		const request = await a.until((e) => e.type === 'join-request')
		expect(request).toBeTruthy()
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
		expect(c.svc.status().members).toBe(0)
	})

	it('a network whose gateway cannot be read is unknown: it cannot be trusted and never auto-admits', async () => {
		const { world, a } = await setup({ networkIdentity: async () => undefined })
		const b = machine('desk', world, [])
		await ask(world, b, a)
		const request = (await a.until((e) => e.type === 'join-request')) as Extract<
			NetworkEvent,
			{ type: 'join-request' }
		>
		await expect(a.svc.networkOf(request.request.sourceAddr)).resolves.toBeUndefined()
		await expect(a.svc.allow(request.request.code, { trust: true })).rejects.toBeInstanceOf(
			NetworkError,
		)
		// nothing was admitted by the refused call; a plain Allow still works
		expect(a.svc.pendingJoins()).toHaveLength(1)
		await a.svc.allow(request.request.code)
		await b.until((e) => e.type === 'joined')
		expect(await a.svc.trustedNetworks()).toEqual([])
	})

	it('autoAdmit always admits on any private network; never asks even on a trusted one', async () => {
		const always = await setup({
			autoAdmit: () => 'always',
			networkIdentity: async () => undefined,
		})
		const b = machine('desk', always.world, [])
		await ask(always.world, b, always.a)
		await b.until((e) => e.type === 'joined')
		expect(always.a.events.find((e) => e.type === 'join-auto')).toMatchObject({ mode: 'always' })
		expect(always.audit.entries.find((e) => e.event === 'join_allowed')?.decision).toBe(
			'automatically (network.autoAdmit is always)',
		)

		let setting: 'trusted-networks' | 'never' = 'trusted-networks'
		const trusted = await setup({ autoAdmit: () => setting })
		await trusted.a.svc.trustNetwork('127.0.0.1', 'Home')
		setting = 'never'
		const c = machine('mini', trusted.world, [])
		await ask(trusted.world, c, trusted.a)
		await trusted.a.until((e) => e.type === 'join-request')
		expect(trusted.a.events.some((e) => e.type === 'join-auto')).toBe(false)
		expect(c.svc.status().members).toBe(0)
	})

	it('untrust removes the network, by name or id prefix, and the next join asks again', async () => {
		const { world, a, audit } = await setup()
		await a.svc.trustNetwork('127.0.0.1', 'Home')
		await a.svc.trustNetwork('127.0.0.1', 'Home renamed')
		expect((await a.svc.trustedNetworks()).map((n) => n.name)).toEqual(['Home renamed'])
		await expect(a.svc.untrustNetwork('nowhere')).rejects.toBeInstanceOf(NetworkError)
		await a.svc.renameNetwork('Home renamed', 'Office')
		await expect(a.svc.renameNetwork('Office', '  ')).rejects.toBeInstanceOf(NetworkError)
		const gone = await a.svc.untrustNetwork('office')
		expect(gone.id).toBe(HOME_NET)
		expect(await a.svc.trustedNetworks()).toEqual([])
		expect(audit.entries.some((e) => e.event === 'network_untrusted')).toBe(true)
		const b = machine('desk', world, [])
		await ask(world, b, a)
		await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
	})

	it('writes trusted-networks.json with mode 0600 and no secret', async () => {
		const { a } = await setup()
		await a.svc.trustNetwork('127.0.0.1')
		const file = join(a.home, 'network', 'trusted-networks.json')
		const text = readFileSync(file, 'utf8')
		expect(JSON.parse(text).networks[0]).toMatchObject({ id: HOME_NET, name: 'Network 1' })
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
	})
})

describe('one machine asks once, however many terminals it has', () => {
	type Waiting = Extract<NetworkEvent, { type: 'join-waiting' }>
	type Requested = Extract<NetworkEvent, { type: 'join-request' }>
	const attemptFile = (home: string) => join(home, 'network', 'join-attempt.json')

	/** The leader of a network, and the machine that asks it: `terminal()` is another process of that machine. */
	async function setup() {
		const world = newWorld()
		const leader = machine('studio', world)
		await found(leader, world.clock)
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		const first = machine('desk', world)
		// Later terminals hear the network from a fake lookup, so a long jump of the clock cannot age its
		// announcement out of the shared one.
		const terminal = () => {
			const fake = createFakeDiscovery()
			const m = machine('desk', world, [], fake, { home: first.home })
			const announce = () =>
				fake.emitFound({
					netId: leader.svc.status().netId as string,
					host: '127.0.0.1',
					port: leader.addr().port,
				})
			return Object.assign(m, { announce })
		}
		return { world, leader, first, terminal }
	}
	async function ask(m: Machine & { announce?: () => void }, world: ReturnType<typeof newWorld>) {
		await m.svc.start()
		m.announce?.()
		world.clock.advance(5000)
		return (await m.until((e) => e.type === 'join-waiting')) as Waiting
	}

	it('a terminal that takes over from one that closed asks again and meets the same request and code', async () => {
		const { world, leader, first, terminal } = await setup()
		const waiting = await ask(first, world)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await first.svc.close()
		leader.fresh()
		const mark = leader.events.length
		// A minute has not passed since the first ask: the member would refuse a second request from this address.
		const second = terminal()
		const again = await ask(second, world)
		expect(again.code).toBe(waiting.code)
		expect(leader.svc.pendingJoins()).toHaveLength(1)
		expect(leader.svc.pendingJoins()[0]?.requestId).toBe(asked.request.requestId)
		expect(leader.events.slice(mark).filter((e) => e.type === 'join-request')).toHaveLength(0)
		// The one Allow reaches the terminal that waits now.
		await leader.svc.allow(asked.request.code)
		await second.until((e) => e.type === 'joined')
	})

	it('two terminals of one machine asking at once leave one request, and the later one holds the answer', async () => {
		const { world, leader, first, terminal } = await setup()
		const a = await ask(first, world)
		await leader.until((e) => e.type === 'join-request')
		const second = terminal()
		const b = await ask(second, world)
		expect(b.code).toBe(a.code)
		expect(leader.svc.pendingJoins()).toHaveLength(1)
		await leader.svc.allow(a.shownCode)
		await second.until((e) => e.type === 'joined')
	})

	it('a different ask from the same machine replaces the waiting one instead of adding a second', async () => {
		const { world, leader, first, terminal } = await setup()
		const waiting = await ask(first, world)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await first.svc.close()
		// The machine lost its record of the ask: a new nonce, so a new code.
		unlinkSync(attemptFile(first.home))
		// The member's one-a-minute limit applies to a different ask too.
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS - 5000)
		const settled = leader.until(
			(e) => e.type === 'join-settled' && e.requestId === asked.request.requestId,
		)
		const again = await ask(terminal(), world)
		await settled
		expect(again.code).not.toBe(waiting.code)
		expect(leader.svc.pendingJoins()).toHaveLength(1)
		expect(leader.svc.pendingJoins()[0]?.code).toBe(again.code)
	})

	it('a different ask inside a minute is refused and leaves the waiting request standing', async () => {
		const { world, leader, first, terminal } = await setup()
		await ask(first, world)
		await leader.until((e) => e.type === 'join-request')
		const asked = leader.svc.pendingJoins()[0]
		unlinkSync(attemptFile(first.home))
		const second = terminal()
		await second.svc.start()
		second.announce()
		world.clock.advance(5000)
		await second.until((e) => e.type === 'join-ended')
		expect(second.events.find((e) => e.type === 'join-ended')).toMatchObject({ result: 'refused' })
		expect(leader.svc.pendingJoins()).toHaveLength(1)
		expect(leader.svc.pendingJoins()[0]?.requestId).toBe(asked?.requestId)
	})

	it('a request whose terminal left is dropped after a short wait, not ten minutes', async () => {
		const { world, leader, first } = await setup()
		await ask(first, world)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await first.svc.close()
		expect(leader.svc.pendingJoins()).toHaveLength(1)
		const startedAt = world.clock.now()
		const settled = leader.until(
			(e) => e.type === 'join-settled' && e.requestId === asked.request.requestId,
		)
		// The member notices the dropped connection on its own turn; each pass moves the fake clock one
		// orphan wait on, never past the ten minutes the request had before.
		let done = false
		void settled.then(() => {
			done = true
		})
		for (let pass = 0; !done; pass++) {
			await new Promise((resolve) => setImmediate(resolve))
			if (!done) world.clock.advance(1000)
		}
		await settled
		expect(leader.svc.pendingJoins()).toEqual([])
		expect(world.clock.now() - startedAt).toBeLessThan(JOIN_EXPIRY_MS)
	})

	it('a refused ask of a person backs the machine off that network too', async () => {
		const { world, leader, first, terminal } = await setup()
		await first.svc.start()
		void first.svc.join(leader.addr()).catch(() => undefined)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await leader.svc.deny(asked.request.code)
		await first.until((e) => e.type === 'join-ended')
		await first.svc.close()
		leader.fresh()
		const mark = leader.events.length
		world.clock.advance(JOIN_BACKOFF_DENIED_MS - 10_000)
		const second = terminal()
		await second.svc.start()
		second.announce()
		world.clock.advance(5000)
		await second.until(
			(e) => e.type === 'state' && e.reason?.includes('will not ask again') === true,
		)
		expect(leader.events.slice(mark).some((e) => e.type === 'join-request')).toBe(false)
	})

	it('after a refusal it does not ask that network again on its own, and a person can', async () => {
		const { world, leader, first, terminal } = await setup()
		await ask(first, world)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await leader.svc.deny(asked.request.code)
		await first.until((e) => e.type === 'join-ended')
		await first.svc.close()
		leader.fresh()
		const mark = leader.events.length
		world.clock.advance(JOIN_BACKOFF_DENIED_MS - 10_000)
		const second = terminal()
		await second.svc.start()
		second.announce()
		world.clock.advance(5000)
		await second.until(
			(e) => e.type === 'state' && e.reason?.includes('will not ask again') === true,
		)
		expect(second.events.some((e) => e.type === 'join-waiting')).toBe(false)
		expect(leader.svc.pendingJoins()).toEqual([])
		expect(leader.events.slice(mark).some((e) => e.type === 'join-request')).toBe(false)
		// A person typing the address asks now, whatever happened before.
		void second.svc.join(leader.addr()).catch(() => undefined)
		await leader.until((e) => e.type === 'join-request')
		await second.svc.close()
		// Once the wait is over the next terminal asks on its own again.
		world.clock.advance(JOIN_BACKOFF_DENIED_MS)
		leader.fresh()
		const third = terminal()
		await ask(third, world)
		await leader.until((e) => e.type === 'join-request')
	})

	it('an ask nobody answered waits a shorter time before the next one', async () => {
		const { world, leader, first, terminal } = await setup()
		await ask(first, world)
		await leader.until((e) => e.type === 'join-request')
		world.clock.advance(JOIN_EXPIRY_MS)
		await first.until((e) => e.type === 'join-ended')
		expect(first.events.find((e) => e.type === 'join-ended')).toMatchObject({ result: 'expired' })
		await first.svc.close()
		leader.fresh()
		world.clock.advance(JOIN_BACKOFF_OTHER_MS - 10_000)
		const early = terminal()
		await early.svc.start()
		early.announce()
		world.clock.advance(5000)
		await early.until(
			(e) => e.type === 'state' && e.reason?.includes('will not ask again') === true,
		)
		expect(early.events.some((e) => e.type === 'join-waiting')).toBe(false)
		await early.svc.close()
		world.clock.advance(JOIN_BACKOFF_OTHER_MS)
		await ask(terminal(), world)
		await leader.until((e) => e.type === 'join-request')
	})

	it('once let in, the machine is remembered: a terminal that opens later asks nothing', async () => {
		const { world, leader, first, terminal } = await setup()
		await ask(first, world)
		const asked = (await leader.until((e) => e.type === 'join-request')) as Requested
		await leader.svc.allow(asked.request.code)
		await first.until((e) => e.type === 'joined')
		expect(existsSync(attemptFile(first.home))).toBe(false)
		await first.svc.close()
		leader.fresh()
		const mark = leader.events.length
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		const later = terminal()
		await later.svc.start()
		world.clock.advance(5000)
		expect(later.svc.status().state).toBe('ready')
		expect(later.svc.members()).toHaveLength(2)
		expect(leader.events.slice(mark).some((e) => e.type === 'join-request')).toBe(false)
	})

	it('a person who cancels withdraws the request from the other machine', async () => {
		const { world, leader, first } = await setup()
		await ask(first, world)
		await leader.until((e) => e.type === 'join-request')
		expect(first.svc.cancelJoin()).toBe(true)
		await leader.until((e) => e.type === 'join-settled')
		// The asking machine clears its own record in its join flow, which says so with
		// `join-ended`; the other machine settling first says nothing about that file.
		await first.until((e) => e.type === 'join-ended' && e.result === 'cancelled')
		expect(leader.svc.pendingJoins()).toEqual([])
		expect(existsSync(attemptFile(first.home))).toBe(false)
	})
})
