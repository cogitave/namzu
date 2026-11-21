import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { type ManualClock, createManualClock } from './clock.js'
import { createDiscoveryHub } from './discovery.js'
import { generateMachineKey } from './identity.js'
import { JOIN_ADDRESS_WINDOW_MS } from './join.js'
import { HOLD_EXPIRY_MS } from './mail-policy.js'
import type { LocalSession } from './roster.js'
import {
	type NetworkEvent,
	type NetworkHost,
	type NetworkService,
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
		discovery: world.hub.create(),
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		listenPort: 0,
		hostname: name,
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
		expect(a.svc.admittedBy(bId)).toEqual([c.svc.identity()?.machineId])
		const result = await a.svc.remove(bId, { cascade: true })
		expect([...result.removed].sort()).toEqual([bId, c.svc.identity()?.machineId as string].sort())
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

describe('manual addresses', () => {
	it('parses host, host:port and bracketed IPv6 and rejects junk', () => {
		expect(parseHostPort('192.168.1.5')).toEqual({ host: '192.168.1.5', port: 47310 })
		expect(parseHostPort('desk.local:5000')).toEqual({ host: 'desk.local', port: 5000 })
		expect(parseHostPort('[fe80::1]:6000')).toEqual({ host: 'fe80::1', port: 6000 })
		expect(() => parseHostPort('bad host')).toThrow(NetworkError)
		expect(() => parseHostPort('x:99999')).toThrow(NetworkError)
	})
})
