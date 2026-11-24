import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import {
	BROWSE_WINDOW_MS,
	type NetworkEvent,
	createDiscoveryHub,
	createManualClock,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { secretForHome } from './computer-secret.js'
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
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const posixOnly = process.platform === 'win32' ? it.skip : it
const noHarden = () => {}

function start(
	world: {
		hub: ReturnType<typeof createDiscoveryHub>
		clock: ReturnType<typeof createManualClock>
	},
	osHome: string,
	home: string,
	sameComputer = true,
) {
	const notices: string[] = []
	const events: NetworkEvent[] = []
	const waiters: Array<{ match: (e: NetworkEvent) => boolean; resolve: () => void }> = []
	mkdirSync(home, { recursive: true })
	const rt = createNetworkRuntime({
		home,
		osHome,
		version: 'fixture',
		env: {},
		settings: {
			enabled: 'auto',
			acceptMail: 'members',
			autoAdmit: 'trusted-networks',
			sameComputer,
		},
		networkIdentity: async () => undefined,
		interactive: true,
		notify: (text) => notices.push(text),
		clock: world.clock,
		interfaces: loopback,
		allowLoopback: true,
		discovery: () => world.hub.create(),
		listenPort: 0,
		hostname: 'studio',
		onEvent: (event) => {
			events.push(event)
			for (const w of [...waiters])
				if (w.match(event)) {
					waiters.splice(waiters.indexOf(w), 1)
					w.resolve()
				}
		},
	})
	runtimes.push(rt)
	return {
		rt,
		notices,
		events,
		until: (match: (e: NetworkEvent) => boolean) =>
			events.some(match)
				? Promise.resolve()
				: new Promise<void>((resolve) => waiters.push({ match, resolve })),
	}
}

describe('secretForHome', () => {
	posixOnly(
		'the default home and a service home share one secret; another home has none',
		async () => {
			const osHome = mkdtempSync(join(tmpdir(), 'nr-os-'))
			roots.push(osHome)
			const def = join(osHome, '.namzu')
			const svc = join(def, 'services', 'autodev')
			mkdirSync(svc, { recursive: true })
			const other = mkdtempSync(join(tmpdir(), 'nr-other-'))
			roots.push(other)
			const a = await secretForHome(def, {}, noHarden, osHome)
			const b = await secretForHome(svc, {}, noHarden, osHome)
			expect(a.source?.path).toBe(join(osHome, '.namzu', 'network', 'machine-secret'))
			expect(a.serviceName).toBeUndefined()
			expect(b.source?.path).toBe(a.source?.path)
			expect(b.serviceName).toBe('autodev')
			expect((await secretForHome(other, {}, noHarden, osHome)).source).toBeUndefined()
		},
	)
})

describe('a service home on this computer', () => {
	async function pair(sameComputer: boolean) {
		const world = { hub: createDiscoveryHub(), clock: createManualClock() }
		const osHome = mkdtempSync(join(tmpdir(), 'nr-os-'))
		roots.push(osHome)
		const def = join(osHome, '.namzu')
		const a = start(world, osHome, def, sameComputer)
		const founded = a.until((e) => e.type === 'founded')
		await a.rt.refresh()
		world.clock.advance(BROWSE_WINDOW_MS)
		await founded
		world.clock.advance(60_000)
		const b = start(world, osHome, join(def, 'services', 'autodev'))
		await b.rt.refresh()
		world.clock.advance(BROWSE_WINDOW_MS)
		return { world, osHome, a, b }
	}

	posixOnly(
		'joins the default home without an Allow, with one passing line naming it',
		async () => {
			const { osHome, a, b } = await pair(true)
			await b.until((e) => e.type === 'joined')
			await a.rt.refresh()
			await a.rt.refresh()
			expect(a.events.some((e) => e.type === 'join-request')).toBe(false)
			expect(a.notices).toContain('studio (autodev) joined from this computer.')
			const secret = join(osHome, '.namzu', 'network', 'machine-secret')
			expect(statSync(secret).mode & 0o077).toBe(0)
			expect(readFileSync(secret, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
			expect((await a.rt.control.roster()).machines.find((m) => m.sameComputer)?.name).toBe(
				'studio (autodev)',
			)
		},
	)

	posixOnly('asks when network.sameComputer is false', async () => {
		const { a } = await pair(false)
		await a.until((e) => e.type === 'join-request')
		expect(a.events.some((e) => e.type === 'join-auto')).toBe(false)
	})
})
