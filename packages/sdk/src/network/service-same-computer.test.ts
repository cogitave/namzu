import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { createMemoryAuditSink } from './audit.js'
import { type ManualClock, createManualClock } from './clock.js'
import { type ComputerSecretSource, computerJoinProof } from './computer.js'
import { createDiscoveryHub } from './discovery.js'
import { type MachineKey, generateMachineKey, importMachineKeyPem } from './identity.js'
import { JOIN_ADDRESS_WINDOW_MS } from './join.js'
import type { LocalSession } from './roster.js'
import {
	type NetworkEvent,
	type NetworkHost,
	type NetworkService,
	type NetworkServiceOptions,
	createNamzuNetwork,
} from './service.js'
import { dialNet } from './transport.js'
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

const posixOnly = process.platform === 'win32' ? it.skip : it

interface Home {
	readonly svc: NetworkService
	readonly events: NetworkEvent[]
	readonly audit: ReturnType<typeof createMemoryAuditSink>
	readonly dir: string
	until(match: (e: NetworkEvent) => boolean): Promise<NetworkEvent>
	fresh(): void
	port(): number
}

type World = { hub: ReturnType<typeof createDiscoveryHub>; clock: ManualClock }
const newWorld = (): World => ({
	hub: createDiscoveryHub(),
	clock: createManualClock(),
})

/** A private folder standing for one OS user's `~/.namzu/network`; the secret is created by the first home that starts. */
function userSecret(): ComputerSecretSource {
	const root = mkdtempSync(join(tmpdir(), 'namzu-net-secret-'))
	homes.push(root)
	return {
		path: join(root, '.namzu', 'network', 'machine-secret'),
		check: 'posix',
		create: true,
	}
}

function home(name: string, world: World, extra: Partial<NetworkServiceOptions> = {}): Home {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-net-same-'))
	homes.push(dir)
	const sessions: LocalSession[] = []
	const host: NetworkHost = {
		listLocalSessions: () => sessions,
		async deliverLocal() {
			return { status: 'queued' }
		},
		setLocalRole: () => false,
	}
	const audit = createMemoryAuditSink()
	const svc = createNamzuNetwork({
		home: dir,
		host,
		interactive: true,
		discovery: world.hub.create(),
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		listenPort: 0,
		hostname: name,
		networkIdentity: async () => undefined,
		audit,
		...extra,
	})
	services.push(svc)
	const events: NetworkEvent[] = []
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
		svc,
		dir,
		events,
		audit,
		fresh: () => {
			cutoff = events.length
		},
		until: (match) => {
			const past = events.slice(cutoff).find(match)
			if (past) return Promise.resolve(past)
			return new Promise((resolve) => waiters.push({ match, resolve }))
		},
		port: () => svc.status().port as number,
	}
}

async function foundWith(world: World, extra: Partial<NetworkServiceOptions>): Promise<Home> {
	const a = home('default-home', world, extra)
	await a.svc.start()
	world.clock.advance(5000)
	await a.until((e) => e.type === 'founded')
	world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
	a.fresh()
	return a
}

describe('same computer: homes sharing the computer secret join without an Allow', () => {
	it('admits a second home by proof, with one join-auto line and no request', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('autodev', world, { machineSecret: secret })
		await b.svc.start()
		world.clock.advance(5000)
		const auto = await a.until((e) => e.type === 'join-auto')
		await b.until((e) => e.type === 'joined')
		expect(auto).toMatchObject({ type: 'join-auto', mode: 'same-computer' })
		expect(a.events.some((e) => e.type === 'join-request')).toBe(false)
		expect(a.svc.status().members).toBe(2)
		expect(b.svc.status().members).toBe(2)
		expect(a.audit.entries.find((e) => e.event === 'join_allowed')?.decision).toBe(
			'automatically (same computer)',
		)
	})

	it('shows each side the other as the same computer, and drops the mark when the secret goes', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('autodev', world, { machineSecret: secret })
		await b.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'joined')
		const fromA = await a.svc.roster({ refresh: false })
		const fromB = await b.svc.roster({ refresh: false })
		expect(fromA.machines.filter((m) => m.sameComputer).map((m) => m.machineId)).toEqual([
			b.svc.identity()?.machineId,
		])
		expect(fromB.machines.filter((m) => m.sameComputer).map((m) => m.machineId)).toEqual([
			a.svc.identity()?.machineId,
		])
		rmSync(secret.path)
		const after = await a.svc.roster({ refresh: false })
		expect(after.machines.some((m) => m.sameComputer)).toBe(false)
	})

	posixOnly('a reset secret does not bring the old marks back', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('autodev', world, { machineSecret: secret })
		await b.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'joined')
		expect((await a.svc.roster({ refresh: false })).machines.some((m) => m.sameComputer)).toBe(true)
		// The person resets the secret; the next home that needs one makes another.
		rmSync(secret.path)
		writeFileSync(secret.path, `${randomBytes(32).toString('hex')}\n`, {
			mode: 0o600,
		})
		expect((await a.svc.roster({ refresh: false })).machines.some((m) => m.sameComputer)).toBe(
			false,
		)
	})

	it('a home without the secret asks, and stays pending until a person allows', async () => {
		const world = newWorld()
		const a = await foundWith(world, { machineSecret: userSecret() })
		const b = home('elsewhere', world)
		await b.svc.start()
		world.clock.advance(5000)
		const request = await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
		expect(b.svc.status().members).toBe(0)
		await a.svc.allow((request as { request: { code: string } }).request.code)
		await b.until((e) => e.type === 'joined')
	})

	it('a home with a different secret asks', async () => {
		const world = newWorld()
		const a = await foundWith(world, { machineSecret: userSecret() })
		const b = home('other-user', world, { machineSecret: userSecret() })
		await b.svc.start()
		world.clock.advance(5000)
		await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
	})

	it('two homes of the computer join within one minute from the same address', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('terminal', world, { machineSecret: secret })
		const c = home('autodev', world, { machineSecret: secret })
		await b.svc.start()
		await c.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'joined')
		await c.until((e) => e.type === 'joined')
		expect(a.svc.status().members).toBe(3)
	})

	it('network.sameComputer false and autoAdmit never both ask', async () => {
		for (const extra of [{ sameComputer: () => false }, { autoAdmit: () => 'never' as const }]) {
			const world = newWorld()
			const secret = userSecret()
			const a = await foundWith(world, { machineSecret: secret, ...extra })
			const b = home('autodev', world, { machineSecret: secret })
			await b.svc.start()
			world.clock.advance(5000)
			await a.until((e) => e.type === 'join-request')
			expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
			await a.svc.close()
			await b.svc.close()
		}
	})

	it('a removed home does not walk back in with a valid proof', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('autodev', world, { machineSecret: secret })
		await b.svc.start()
		world.clock.advance(5000)
		await b.until((e) => e.type === 'joined')
		const removedKey = importMachineKeyPem(
			readFileSync(join(b.dir, 'network', 'machine.key.pem'), 'utf8'),
		)
		await a.svc.add(`127.0.0.1:${b.port()}`)
		await b.svc.add(`127.0.0.1:${a.port()}`)
		await a.svc.remove(b.svc.identity()?.machineId as string)
		await b.until((e) => e.type === 'removed-self')
		expect(a.svc.status().members).toBe(1)
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
		const realBytes = Buffer.from(readFileSync(secret.path, 'utf8').trim(), 'hex')
		const { first } = await asRemoved(a, world, removedKey, realBytes)
		expect((first as { status?: string }).status).toBe('refused')
		expect(a.svc.status().members).toBe(1)
	})
})

type Ids = { joiner: string; member: string; nonce: string }

/** A join_request sent straight over TLS by a key of the test's choosing, with whatever proof it likes. */
async function rawJoin(
	a: Home,
	world: World,
	key: MachineKey,
	proof: (ids: Ids) => string | undefined,
	after?: () => Promise<unknown>,
): Promise<{ first: unknown; after: unknown }> {
	const identity = {
		key,
		certificatePem: buildMachineCertificate(key, { now: world.clock.now() }).pem,
	}
	const client = await dialNet({
		identity,
		host: '127.0.0.1',
		port: a.port(),
		clock: world.clock,
	})
	a.fresh()
	const nonce = randomBytes(16).toString('base64')
	const computerProof = proof({
		joiner: key.machineId,
		member: a.svc.identity()?.machineId as string,
		nonce,
	})
	try {
		const first = await client.request({
			protocol: NET_PROTOCOL,
			op: 'join_request',
			machineName: 'this computer',
			publicKey: key.publicKeyDer.toString('base64'),
			nonce,
			...(computerProof ? { computerProof } : {}),
		})
		return { first, after: await after?.() }
	} finally {
		client.close()
		world.clock.advance(JOIN_ADDRESS_WINDOW_MS)
	}
}

async function asRemoved(a: Home, world: World, key: MachineKey, secret: Buffer) {
	return rawJoin(a, world, key, (i) => computerJoinProof(secret, i.joiner, i.member, i.nonce))
}

async function ask(
	a: Home,
	proof: (ids: Ids) => string | undefined,
	world: World,
): Promise<{ first: unknown; event: NetworkEvent | undefined }> {
	const r = await rawJoin(a, world, generateMachineKey(), proof, () =>
		a.until((e) => e.type === 'join-request' || e.type === 'join-auto'),
	)
	return { first: r.first, event: r.after as NetworkEvent }
}

describe('same computer: a claim without the proof is the ordinary ask', () => {
	it('random, wrong-secret, wrong-member and other-joiner proofs all end in a request; the right one does not', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const real = (await import('node:fs')).readFileSync(secret.path, 'utf8').trim()
		const realBytes = Buffer.from(real, 'hex')
		const other = randomBytes(32)
		const forged: [string, (ids: Ids) => string | undefined][] = [
			['random bytes', () => randomBytes(32).toString('base64')],
			['another secret', (i) => computerJoinProof(other, i.joiner, i.member, i.nonce)],
			['another member id', (i) => computerJoinProof(realBytes, i.joiner, 'f'.repeat(64), i.nonce)],
			['another joiner id', (i) => computerJoinProof(realBytes, 'a'.repeat(64), i.member, i.nonce)],
			['another nonce', (i) => computerJoinProof(realBytes, i.joiner, i.member, `${i.nonce}x`)],
			['no proof at all', () => undefined],
		]
		for (const [label, proof] of forged) {
			const { first, event } = await ask(a, proof, world)
			expect(event?.type, label).toBe('join-request')
			expect((first as { status?: string }).status, label).toBe('pending')
		}
		expect(a.audit.entries.filter((e) => e.event === 'same_computer_mismatch')).toHaveLength(5)
		const good = await ask(
			a,
			(i) => computerJoinProof(realBytes, i.joiner, i.member, i.nonce),
			world,
		)
		expect(good.event).toMatchObject({
			type: 'join-auto',
			mode: 'same-computer',
		})
	})

	it('wrong proofs from one address are logged once per joiner, and past a few are not even checked', async () => {
		const world = newWorld()
		const a = await foundWith(world, { machineSecret: userSecret() })
		const key = generateMachineKey()
		for (let i = 0; i < 3; i++)
			await rawJoin(a, world, key, () => randomBytes(32).toString('base64'))
		expect(a.audit.entries.filter((e) => e.event === 'same_computer_mismatch')).toHaveLength(1)
		// Many keys from one address inside one window: only the first few are verified.
		const bad = () => randomBytes(32).toString('base64')
		for (let i = 0; i < 8; i++) {
			const k = generateMachineKey()
			const identity = {
				key: k,
				certificatePem: buildMachineCertificate(k, { now: world.clock.now() }).pem,
			}
			const client = await dialNet({
				identity,
				host: '127.0.0.1',
				port: a.port(),
				clock: world.clock,
			})
			await client.request({
				protocol: NET_PROTOCOL,
				op: 'join_request',
				machineName: 'x',
				publicKey: k.publicKeyDer.toString('base64'),
				nonce: randomBytes(16).toString('base64'),
				computerProof: bad(),
			})
			client.close()
		}
		const lines = a.audit.entries.filter((e) => e.event === 'same_computer_mismatch').length
		expect(lines).toBeLessThanOrEqual(1 + 5)
	})

	posixOnly('a secret file readable by others is refused and the home asks', async () => {
		const world = newWorld()
		const secret = userSecret()
		const a = await foundWith(world, { machineSecret: secret })
		const b = home('autodev', world, { machineSecret: secret })
		chmodSync(secret.path, 0o644)
		await b.svc.start()
		world.clock.advance(5000)
		await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
		expect(b.audit.entries.some((e) => e.event === 'same_computer_unavailable')).toBe(true)
	})

	posixOnly(
		'a symbolic link in place of the secret is refused and nothing is regenerated',
		async () => {
			const world = newWorld()
			const secret = userSecret()
			const a = await foundWith(world, { machineSecret: secret })
			rmSync(secret.path)
			const target = join(mkdtempSync(join(tmpdir(), 'namzu-net-link-')), 'real')
			homes.push(join(target, '..'))
			writeFileSync(target, `${'ab'.repeat(32)}\n`, { mode: 0o600 })
			symlinkSync(target, secret.path)
			const b = home('autodev', world, { machineSecret: secret })
			await b.svc.start()
			world.clock.advance(5000)
			await a.until((e) => e.type === 'join-request')
			expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
			mkdirSync(join(secret.path, '..'), { recursive: true })
		},
	)
})
