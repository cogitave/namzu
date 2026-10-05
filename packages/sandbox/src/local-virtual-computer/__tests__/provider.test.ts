import { createHash } from 'node:crypto'
import type { PalDefinition } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localComputerClients } from '../client.js'
import { type LocalComputerCommandRunner, assertLocalEngineEndpoint } from '../engine.js'
import { createLocalVirtualComputerProvider } from '../index.js'
import * as podman from '../podman-machine.js'
import { LocalForwardCleanupError } from '../ssh-forward.js'

const pal: PalDefinition = {
	v: 1,
	kind: 'pal',
	id: 'pal-one',
	name: 'One',
	purpose: '',
	workspace: '/host/control/private',
	model: null,
	paused: false,
	revision: 1,
	createdAt: '2026-10-02',
	updatedAt: '2026-10-02',
}
const containerId = 'a'.repeat(64)
const owner = (id: string) => createHash('sha256').update(id).digest('hex')

function engineFixture(
	options: {
		endpoint?: string
		existingContainer?: boolean
		wrongVolume?: boolean
		failStart?: boolean
		cleanupFails?: boolean
	} = {},
) {
	const calls: {
		binary: string
		args: readonly string[]
		env?: NodeJS.ProcessEnv
	}[] = []
	let allocated = false
	const runner: LocalComputerCommandRunner = {
		async run(binary, args, call) {
			calls.push({ binary, args, env: call?.env })
			if (args[0] === 'context') {
				if (args[1] === 'show') return 'fixture-local'
				return JSON.stringify([
					{ Endpoints: { docker: { Host: options.endpoint ?? 'unix:///var/run/docker.sock' } } },
				])
			}
			const op = args.slice(2)
			if (op[0] === 'info') return JSON.stringify({ OSType: 'linux' })
			if (op[0] === 'image')
				return JSON.stringify([
					{
						Os: 'linux',
						Config: { User: '1001:1001', Labels: { 'org.namzu.local-computer.protocol': '1' } },
					},
				])
			if (op[0] === 'ps') {
				if (op.includes('--no-trunc')) return allocated ? containerId : ''
				return options.existingContainer ? 'earlier-allocation' : ''
			}
			if (op[0] === 'volume') {
				if (op[1] === 'create') return String(op.at(-1))
				const hash = String(op.at(-1)).slice('namzu-pal-data-'.length)
				return JSON.stringify([
					{ Labels: { 'org.namzu.pal.owner': options.wrongVolume ? 'other-owner' : hash } },
				])
			}
			if (op[0] === 'run') {
				allocated = true
				if (options.failStart) throw new Error('Lost Docker acknowledgement')
				return containerId
			}
			if (op[0] === 'inspect')
				return JSON.stringify({
					'2024/tcp': [{ HostIp: '127.0.0.1', HostPort: '41124' }],
					'2025/tcp': [{ HostIp: '127.0.0.1', HostPort: '41125' }],
				})
			if (op[0] === 'rm') {
				if (options.cleanupFails) throw new Error('Cleanup transport failed')
				allocated = false
				return containerId
			}
			if (op[0] === 'stop') return containerId
			throw new Error(`Unexpected fixture operation ${op[0]}`)
		},
	}
	return { runner, calls }
}

function stubReadiness(stream?: unknown, heldKeyboard?: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async (url: string) =>
				new Response(
					JSON.stringify(
						url.endsWith('/readyz')
							? { protocol: 1, width: 1280, height: 800, browserReady: true, stream, heldKeyboard }
							: { protocolVersion: 2 },
					),
					{ status: 200 },
				),
		),
	)
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

describe('local Pal computer admission', () => {
	it.each([
		'tcp://127.0.0.1:2375',
		'tcp://remote:2376',
		'ssh://host',
		'npipe:////remote/pipe/docker_engine',
		'unix://relative',
		'https://host',
	])('refuses an engine without a local endpoint boundary: %s', (endpoint) => {
		expect(() => assertLocalEngineEndpoint(endpoint)).toThrow('local Docker')
	})
	it.each([
		'unix:///var/run/docker.sock',
		'unix:///home/operator/.docker/run/docker.sock',
		'npipe:////./pipe/dockerDesktopLinuxEngine',
	])('recognizes supported local device transports: %s', (endpoint) => {
		expect(() => assertLocalEngineEndpoint(endpoint)).not.toThrow()
	})
	it('refuses a remote configured context before reaching the daemon', async () => {
		const fixture = engineFixture({ endpoint: 'ssh://other-machine' })
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal,
				conversationId: 'conversation',
			}),
		).rejects.toThrow('local Docker')
		expect(fixture.calls.every((call) => call.args[0] === 'context')).toBe(true)
	})
	it('reports a remote context diagnosis without leaking raw engine errors', async () => {
		const fixture = engineFixture({ endpoint: 'ssh://other-machine' })
		expect(
			await createLocalVirtualComputerProvider({ runner: fixture.runner }).probe?.(),
		).toMatchObject({ ready: false, reason: expect.stringContaining('remote engines are refused') })
	})
	it('does not certify a local context while DOCKER_HOST redirects to a remote engine', async () => {
		vi.stubEnv('DOCKER_HOST', 'tcp://remote:2375')
		const fixture = engineFixture()
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal,
				conversationId: 'conversation',
			}),
		).rejects.toThrow('remote engines')
	})
	it('pins native Windows commands to the verified named pipe', async () => {
		const fixture = engineFixture({ endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine' })
		const provider = createLocalVirtualComputerProvider({
			runner: fixture.runner,
			dockerBinary: 'C:\\Program Files\\Docker\\docker.exe',
		})
		expect(await provider.probe?.()).toEqual({ ready: true })
		expect(
			fixture.calls
				.filter((call) => call.args[0] !== 'context')
				.every(
					(call) =>
						call.args[0] === '--host' &&
						call.args[1] === 'npipe:////./pipe/dockerDesktopLinuxEngine',
				),
		).toBe(true)
		expect(fixture.calls.every((call) => call.binary.endsWith('docker.exe'))).toBe(true)
	})
	it('allocates a real guest contract with a private named volume and no host mount', async () => {
		stubReadiness()
		const fixture = engineFixture()
		const provider = createLocalVirtualComputerProvider({ runner: fixture.runner })
		const lease = await provider.acquire({ pal, conversationId: 'conversation' })
		const run = fixture.calls.find((call) => call.args[2] === 'run')!
		expect(run.args).toContain(
			`type=volume,source=namzu-pal-data-${owner(pal.id)},target=/home/namzu`,
		)
		expect(run.args.join(' ')).not.toContain(pal.workspace)
		expect(
			run.args
				.filter((arg) => arg.startsWith('type='))
				.every((arg) => arg.startsWith('type=volume,')),
		).toBe(true)
		expect(run.args.join(' ')).not.toContain(run.env!.NAMZU_SANDBOX_TOKEN)
		expect(run.args).toContain('--pull=never')
		expect(run.args).toContain('127.0.0.1::2024')
		expect(run.args).toContain('127.0.0.1::2025')
		expect(lease.sandbox.rootDir).toBe('/home/namzu/workspace')
		expect(lease.computerUseHost.capabilities.screenshot).toBe(true)
		expect(lease.screenStream).toBeUndefined()
		expect(lease.sandbox.openTerminal).toBeUndefined()
		expect(lease.sandbox.spawnDetached).toBeTypeOf('function')
		await expect(provider.acquire({ pal, conversationId: 'other' })).rejects.toThrow(
			'already in use',
		)
		await lease.release()
		await lease.release()
		expect(fixture.calls.filter((call) => call.args[2] === 'stop')).toHaveLength(1)
		expect(fixture.calls.filter((call) => call.args[2] === 'rm')).toHaveLength(1)
		expect(
			fixture.calls.some((call) => call.args.includes('volume') && call.args.includes('rm')),
		).toBe(false)
		await expect(lease.computerUseHost.execute({ type: 'screenshot' })).rejects.toThrow(
			'lease has ended',
		)
	})
	it('keeps explicitly strict foreground ownership compatible with an older worker', async () => {
		stubReadiness()
		const fixture = engineFixture()
		const provider = createLocalVirtualComputerProvider({
			runner: fixture.runner,
			normalExitPolicy: 'strict',
		})
		const lease = await provider.acquire({ pal, conversationId: 'strict-compatibility' })
		const requests: { url: string; body: Record<string, unknown> }[] = []
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
			if (url.endsWith('/executions/reserve'))
				return Response.json({
					ok: true,
					protocolVersion: 2,
					executionId: 'exec_00000000-0000-4000-8000-000000000001',
					leaseExpiresAt: Date.now() + 30_000,
				})
			return new Response(
				`${JSON.stringify({ type: 'result', exitCode: 0, timedOut: false, durationMs: 1 })}\n`,
			)
		})
		await expect(lease.sandbox.exec('true', [])).resolves.toMatchObject({ exitCode: 0 })
		expect(requests).toHaveLength(2)
		expect(requests[1]?.body).not.toHaveProperty('normalExitPolicy')
		await lease.release()
	})
	it('refuses an invalid foreground lifetime before touching the local engine', () => {
		const fixture = engineFixture()
		expect(() =>
			createLocalVirtualComputerProvider({
				runner: fixture.runner,
				normalExitPolicy: 'unknown' as 'strict',
			}),
		).toThrow('Choose strict or computer-lifetime')
		expect(fixture.calls).toEqual([])
	})
	it('exposes a host-only RFB descriptor from actual readiness through the existing owned desktop port', async () => {
		stubReadiness({ protocol: 'rfb' })
		const fixture = engineFixture()
		const provider = createLocalVirtualComputerProvider({ runner: fixture.runner })
		const lease = await provider.acquire({ pal, conversationId: 'stream-view' })
		const run = fixture.calls.find((call) => call.args[2] === 'run')!
		expect(lease.screenStream).toEqual({
			protocol: 'rfb',
			url: 'ws://127.0.0.1:41125/stream',
			authorization: `Bearer ${run.env!.NAMZU_SANDBOX_TOKEN}`,
		})
		expect(Object.isFrozen(lease.screenStream)).toBe(true)
		expect(run.args).not.toContain('127.0.0.1::5900')
		await lease.release()
	})
	it('advertises held operator keys only for a confirmed current guest protocol', async () => {
		for (const advertised of [undefined, { version: 2 }, { version: 1 }]) {
			stubReadiness(undefined, advertised)
			const fixture = engineFixture()
			const provider = createLocalVirtualComputerProvider({ runner: fixture.runner })
			const lease = await provider.acquire({ pal, conversationId: 'held-keyboard' })
			expect(lease.operatorControl?.heldKeyboard).toBe(advertised?.version === 1 ? true : undefined)
			await lease.release()
		}
	})
	it('does not invent RFB support for another advertised stream protocol', async () => {
		stubReadiness({ protocol: 'unknown' })
		const fixture = engineFixture()
		const lease = await createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
			pal,
			conversationId: 'not-rfb',
		})
		expect(lease.screenStream).toBeUndefined()
		await lease.release()
	})
	it('retains the Pal lane and retries owned forwarding cleanup after guest removal', async () => {
		stubReadiness()
		const fixture = engineFixture()
		const close = vi
			.fn()
			.mockRejectedValueOnce(new Error('Forwarding stop unconfirmed'))
			.mockResolvedValue(undefined)
		const forward = { ports: [41124, 41125], assertAlive: vi.fn(), close }
		const forwardPorts = vi.fn(async () => forward)
		vi.spyOn(podman, 'resolveLocalPodmanEngine').mockResolvedValue({
			endpoint: 'npipe:////./pipe/local-machine',
			run: (args, options) =>
				fixture.runner.run('podman', ['--host', 'local-fixture', ...args], options),
			forwardPorts,
		})
		const provider = createLocalVirtualComputerProvider({ engine: 'podman' })
		const lease = await provider.acquire({ pal, conversationId: 'owned-forward' })
		expect(fixture.calls.find((call) => call.args[2] === 'run')?.args).toContain(
			'--cgroups=disabled',
		)
		expect(
			fixture.calls.find((call) => call.args[2] === 'volume' && call.args[3] === 'create')?.args,
		).toContain('--ignore')
		await expect(lease.release()).rejects.toThrow('unconfirmed')
		expect(lease.sandbox.status).toBe('destroyed')
		await expect(provider.acquire({ pal, conversationId: 'blocked' })).rejects.toThrow(
			'already in use',
		)
		await lease.release()
		expect(close).toHaveBeenCalledTimes(2)
		expect(fixture.calls.filter((call) => call.args[2] === 'rm')).toHaveLength(1)
		expect(forwardPorts).toHaveBeenCalledWith(
			[41124, 41125],
			expect.objectContaining({ onLost: expect.any(Function) }),
		)
	})
	it('fences and retires the guest when its owned forwarding helper is lost', async () => {
		stubReadiness()
		const fixture = engineFixture()
		let lost: (() => void) | undefined
		const close = vi.fn(async () => undefined)
		vi.spyOn(podman, 'resolveLocalPodmanEngine').mockResolvedValue({
			endpoint: 'npipe:////./pipe/local-machine',
			run: (args, options) =>
				fixture.runner.run('podman', ['--host', 'local-fixture', ...args], options),
			async forwardPorts(_ports, options) {
				lost = options.onLost
				return { ports: [41124, 41125], assertAlive: vi.fn(), close }
			},
		})
		const lease = await createLocalVirtualComputerProvider({ engine: 'podman' }).acquire({
			pal,
			conversationId: 'forward-loss',
		})
		lost?.()
		expect(lease.sandbox.status).toBe('destroyed')
		await expect(lease.sandbox.exec('must-not-run', [])).rejects.toThrow('lease has ended')
		await lease.release()
		expect(close).toHaveBeenCalledTimes(1)
		expect(fixture.calls.filter((call) => call.args[2] === 'rm')).toHaveLength(1)
	})
	it('retains and recovers only its failed startup forwarding authority before allocating again', async () => {
		stubReadiness()
		const fixture = engineFixture()
		const failedClose = vi
			.fn()
			.mockRejectedValueOnce(new Error('Unknown helper stop'))
			.mockResolvedValue(undefined)
		const retained = { ports: [41124, 41125], assertAlive: vi.fn(), close: failedClose }
		const close = vi.fn(async () => undefined)
		const forwardPorts = vi
			.fn()
			.mockRejectedValueOnce(new LocalForwardCleanupError(retained, Error('Handshake failed')))
			.mockResolvedValue({ ...retained, close })
		vi.spyOn(podman, 'resolveLocalPodmanEngine').mockResolvedValue({
			endpoint: 'npipe:////./pipe/local-machine',
			run: (args, options) =>
				fixture.runner.run('podman', ['--host', 'local-fixture', ...args], options),
			forwardPorts,
		})
		const provider = createLocalVirtualComputerProvider({ engine: 'podman' })
		await expect(provider.acquire({ pal, conversationId: 'failed-startup' })).rejects.toThrow(
			'cleanup could not be confirmed',
		)
		const lease = await provider.acquire({ pal, conversationId: 'recovery-retry' })
		expect(failedClose).toHaveBeenCalledTimes(2)
		expect(fixture.calls.filter((call) => call.args[2] === 'rm')).toHaveLength(1)
		await lease.release()
		expect(close).toHaveBeenCalledTimes(1)
	})
	it('isolates different Pals and mints a fresh token on each allocation', async () => {
		stubReadiness()
		const fixture = engineFixture()
		const provider = createLocalVirtualComputerProvider({ runner: fixture.runner })
		const first = await provider.acquire({ pal, conversationId: 'a' })
		const second = await provider.acquire({ pal: { ...pal, id: 'pal-two' }, conversationId: 'b' })
		const starts = fixture.calls.filter((call) => call.args[2] === 'run')
		expect(starts[0]!.env!.NAMZU_SANDBOX_TOKEN).not.toBe(starts[1]!.env!.NAMZU_SANDBOX_TOKEN)
		expect(first.environmentId).not.toBe(second.environmentId)
		await first.release()
		await second.release()
	})
	it('refuses an earlier allocation without deleting it', async () => {
		const fixture = engineFixture({ existingContainer: true })
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal,
				conversationId: 'c',
			}),
		).rejects.toThrow('earlier Pal computer')
		expect(
			fixture.calls.some((call) => call.args.includes('rm') || call.args.includes('run')),
		).toBe(false)
	})
	it('refuses a foreign data volume', async () => {
		const fixture = engineFixture({ wrongVolume: true })
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal,
				conversationId: 'c',
			}),
		).rejects.toThrow('different owner')
		expect(fixture.calls.some((call) => call.args.includes('run'))).toBe(false)
	})
	it('reconciles an unacknowledged allocation by its unique attempt label', async () => {
		const fixture = engineFixture({ failStart: true })
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal,
				conversationId: 'c',
			}),
		).rejects.toThrow('Lost Docker acknowledgement')
		const cleanup = fixture.calls.filter((call) => call.args[2] === 'rm')
		expect(cleanup[0]!.args.at(-1)).toBe(containerId)
		expect(
			fixture.calls.some(
				(call) =>
					call.args.includes('--no-trunc') &&
					call.args.some((arg) => arg.startsWith('label=org.namzu.pal.allocation=')),
			),
		).toBe(true)
	})
	it('reports failed cleanup and keeps the resource lane fenced', async () => {
		const fixture = engineFixture({ failStart: true, cleanupFails: true })
		const provider = createLocalVirtualComputerProvider({ runner: fixture.runner })
		await expect(provider.acquire({ pal, conversationId: 'c' })).rejects.toThrow(
			'cleanup could not be confirmed',
		)
		await expect(provider.acquire({ pal, conversationId: 'again' })).rejects.toThrow(
			'already in use',
		)
	})
	it('does not claim connected when actual guest readiness fails', async () => {
		vi.useFakeTimers()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 503 })),
		)
		const fixture = engineFixture()
		const provider = createLocalVirtualComputerProvider({
			runner: fixture.runner,
			readyTimeoutMs: 500,
		})
		const failure = expect(provider.acquire({ pal, conversationId: 'c' })).rejects.toThrow(
			'deadline expired',
		)
		await vi.advanceTimersByTimeAsync(501)
		await failure
	})
	it('refuses paused Pals before provisioning', async () => {
		const fixture = engineFixture()
		await expect(
			createLocalVirtualComputerProvider({ runner: fixture.runner }).acquire({
				pal: { ...pal, paused: true },
				conversationId: 'c',
			}),
		).rejects.toThrow('paused')
		expect(fixture.calls).toHaveLength(0)
	})
})

describe('computer lease clients', () => {
	it('does not turn an unconfirmed mutation into a safely replayable failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not-json', { status: 200 })),
		)
		const clients = localComputerClients({
			executionUrl: 'http://127.0.0.1:41124',
			desktopUrl: 'http://127.0.0.1:41125',
			token: 'private-token',
			geometry: { width: 1280, height: 800, scaleFactor: 1 },
			stop: async () => {},
		})
		await expect(
			clients.computerUseHost.execute({ type: 'type_text', text: 'hello' }),
		).rejects.toMatchObject({ code: 'computer_use_outcome_unknown', retrySafety: 'unsafe' })
	})
	it('refuses an older worker before any file bytes are requested', async () => {
		const fetch = vi.fn(
			async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
		)
		vi.stubGlobal('fetch', fetch)
		const clients = localComputerClients({
			executionUrl: 'http://127.0.0.1:41124',
			desktopUrl: 'http://127.0.0.1:41125',
			token: 'private-token',
			geometry: { width: 1280, height: 800, scaleFactor: 1 },
			stop: async () => {},
		})
		await expect(clients.sandbox.readFile('file', { offset: 2 })).rejects.toThrow(
			'bounded file reads',
		)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
			capabilitiesOnly: true,
		})
	})
	it('acknowledges and validates exact bounded reads, retaining ordinary reads', async () => {
		const bodies: Record<string, unknown>[] = []
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(init?.body as string)
			bodies.push(body)
			if (body.capabilitiesOnly)
				return Response.json({
					ok: true,
					readFileRanges: { version: 1, maxBytes: 32 * 1024 * 1024 },
				})
			return Response.json({
				ok: true,
				content: Buffer.from('abc').toString('base64'),
				sizeBytes: 3,
				...(body.range ? { range: { ...body.range, length: body.range.length ?? null } } : {}),
			})
		})
		vi.stubGlobal('fetch', fetch)
		const clients = localComputerClients({
			executionUrl: 'http://127.0.0.1:41124',
			desktopUrl: 'http://127.0.0.1:41125',
			token: 'private-token',
			geometry: { width: 1280, height: 800, scaleFactor: 1 },
			stop: async () => {},
		})
		expect(await clients.sandbox.readFile('image', { offset: 2, length: 3 })).toEqual(
			Buffer.from('abc'),
		)
		expect(await clients.sandbox.readFile('image', { offset: 0 })).toEqual(Buffer.from('abc'))
		expect(await clients.sandbox.readFile('image')).toEqual(Buffer.from('abc'))
		expect(bodies).toEqual([
			{ capabilitiesOnly: true },
			{
				path: 'image',
				encoding: 'base64',
				range: { version: 1, offset: 2, length: 3 },
			},
			{ path: 'image', encoding: 'base64', range: { version: 1, offset: 0 } },
			{ path: 'image', encoding: 'base64' },
		])
	})
	it.each([{ offset: -1 }, { offset: 1.5 }, { length: -1 }, { length: 32 * 1024 * 1024 + 1 }])(
		'refuses invalid range %j without guest I/O',
		async (range) => {
			const fetch = vi.fn()
			vi.stubGlobal('fetch', fetch)
			const clients = localComputerClients({
				executionUrl: 'http://127.0.0.1:41124',
				desktopUrl: 'http://127.0.0.1:41125',
				token: 'private-token',
				geometry: { width: 1280, height: 800, scaleFactor: 1 },
				stop: async () => {},
			})
			await expect(clients.sandbox.readFile('image', range)).rejects.toThrow('read range')
			expect(fetch).not.toHaveBeenCalled()
		},
	)
	it.each([
		{
			range: { version: 1, offset: 1, length: 3 },
			sizeBytes: 3,
			content: 'YWJj',
		},
		{
			range: { version: 1, offset: 0, length: 3 },
			sizeBytes: 4,
			content: 'YWJjZA==',
		},
		{
			range: { version: 1, offset: 0, length: 3 },
			sizeBytes: 2,
			content: 'YWJj',
		},
	])('refuses an unconfirmed or oversized worker range', async (result) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init?: RequestInit) =>
				Response.json(
					JSON.parse(init?.body as string).capabilitiesOnly
						? {
								ok: true,
								readFileRanges: { version: 1, maxBytes: 32 * 1024 * 1024 },
							}
						: { ok: true, ...result },
				),
			),
		)
		const clients = localComputerClients({
			executionUrl: 'http://127.0.0.1:41124',
			desktopUrl: 'http://127.0.0.1:41125',
			token: 'private-token',
			geometry: { width: 1280, height: 800, scaleFactor: 1 },
			stop: async () => {},
		})
		await expect(clients.sandbox.readFile('image', { length: 3 })).rejects.toThrow('worker')
	})
})
