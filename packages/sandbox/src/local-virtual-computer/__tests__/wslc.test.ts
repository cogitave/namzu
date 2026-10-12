import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PalDefinition } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	containerIdQuery,
	ensureVolume,
	hardeningFlags,
	parsePublishedPorts,
	portsQuery,
	resourceFlags,
} from '../dialect.js'
import {
	LocalCommandError,
	type LocalComputerCommandRunner,
	LocalComputerSetupError,
	type LocalEngine,
	extractErrorCodes,
} from '../engine.js'
import { createLocalVirtualComputerProvider } from '../index.js'
import {
	WSLC_MINIMUM_VERSION,
	mapWslcFailure,
	parseWslcVersion,
	resolveLocalWslcEngine,
} from '../wslc-engine.js'

const pal: PalDefinition = {
	v: 1,
	kind: 'pal',
	id: 'pal-wslc',
	name: 'Wslc',
	purpose: '',
	workspace: '/host/control/private',
	model: null,
	paused: false,
	revision: 1,
	createdAt: '2026-10-12',
	updatedAt: '2026-10-12',
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.unstubAllEnvs()
})

describe('wslc dialect', () => {
	it('keeps the docker and podman flags and drops the five wslc cannot take', () => {
		expect(hardeningFlags('docker')).toEqual([
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--read-only',
			'--ipc=private',
		])
		expect(hardeningFlags('podman')).toEqual(hardeningFlags('docker'))
		expect(hardeningFlags('wslc')).toEqual([])
		expect(resourceFlags('podman')).toEqual(['--cgroups=disabled'])
		expect(resourceFlags('docker')).toEqual([])
		expect(resourceFlags('wslc')).toEqual([])
	})
	it('asks for full ids without Go templates on wslc', () => {
		expect(containerIdQuery('wslc', 'name=^/x$', { full: false })).toEqual([
			'ps',
			'-a',
			'--filter',
			'name=^/x$',
			'-q',
			'--no-trunc',
		])
		expect(containerIdQuery('docker', 'label=a=b', { full: true })).toEqual([
			'ps',
			'--all',
			'--filter',
			'label=a=b',
			'--no-trunc',
			'--format',
			'{{.ID}}',
		])
		expect(portsQuery('wslc', 'c')).toEqual(['inspect', '-f', 'json', 'c'])
		expect(portsQuery('podman', 'c')).toEqual([
			'inspect',
			'--format',
			'{{json .NetworkSettings.Ports}}',
			'c',
		])
	})
	it('reads published ports from both wslc inspect shapes, with CRLF', () => {
		const ports = { '2024/tcp': [{ HostIp: '127.0.0.1', HostPort: '54547' }] }
		// Recorded in the spike: top-level Ports, NetworkSettings without Ports.
		expect(
			parsePublishedPorts(
				'wslc',
				`${JSON.stringify([{ Ports: ports, NetworkSettings: { Networks: {} } }])}\r\n`,
			),
		).toEqual(ports)
		// Fallback shape, as Docker prints it.
		expect(
			parsePublishedPorts('wslc', JSON.stringify([{ NetworkSettings: { Ports: ports } }])),
		).toEqual(ports)
		expect(parsePublishedPorts('wslc', '[]')).toEqual({})
		// Docker and Podman print the map itself.
		expect(parsePublishedPorts('docker', JSON.stringify(ports))).toEqual(ports)
	})
	it('creates a volume only when it is absent, and never passes --ignore', async () => {
		const run = vi.fn<LocalEngine['run']>()
		const engine = { endpoint: 'x', run } as LocalEngine
		run.mockRejectedValueOnce(new LocalCommandError('failed', ['WSLC_E_VOLUME_NOT_FOUND']))
		await ensureVolume(engine, 'wslc', 'vol', 'k=v')
		expect(run.mock.calls.map((call) => call[0])).toEqual([
			['volume', 'inspect', 'vol'],
			['volume', 'create', '--label', 'k=v', 'vol'],
		])
		run.mockReset()
		run.mockResolvedValueOnce('[]\r\n')
		await ensureVolume(engine, 'wslc', 'vol', 'k=v')
		expect(run.mock.calls[1]?.[0]).toEqual(['volume', 'create', '--label', 'k=v', 'vol'])
		run.mockReset()
		run.mockResolvedValueOnce('[\r\n  {"Name":"vol"}\r\n]\r\n')
		await ensureVolume(engine, 'wslc', 'vol', 'k=v')
		expect(run).toHaveBeenCalledTimes(1)
	})
})

describe('wslc engine probe', () => {
	const runnerFor = (
		replies: Record<string, string | Error>,
	): { runner: LocalComputerCommandRunner; calls: string[][] } => {
		const calls: string[][] = []
		return {
			calls,
			runner: {
				async run(_binary, args) {
					calls.push([...args])
					const reply = replies[args[0] ?? '']
					if (reply instanceof Error) throw reply
					return reply ?? ''
				},
			},
		}
	}
	it.each([
		['wslc 3.0.1.0\r\n', [3, 0, 1]],
		['wslc 2.9.3.0', [2, 9, 3]],
		['WSLC 10.1.0', [10, 1, 0]],
		['nothing useful', undefined],
		['', undefined],
	])('parses %j', (output, expected) => {
		expect(parseWslcVersion(output)).toEqual(expected)
	})
	it('accepts the floor and later, with CRLF output and an empty ps list', async () => {
		for (const version of [
			`wslc ${WSLC_MINIMUM_VERSION.join('.')}.0\r\n`,
			'wslc 3.0.1.0\r\n',
			'wslc 2.10.0.0',
		]) {
			const { runner, calls } = runnerFor({ version, ps: '' })
			const engine = await resolveLocalWslcEngine({ runner, wslcBinary: 'wslc' })
			expect(engine.dialect).toBe('wslc')
			expect(calls).toEqual([['version'], ['ps', '-a', '-q']])
		}
	})
	it.each(['wslc 2.9.2.0', 'wslc 2.8.9', 'wslc 1.9.9'])(
		'refuses %s as too old',
		async (version) => {
			const { runner } = runnerFor({ version })
			await expect(resolveLocalWslcEngine({ runner, wslcBinary: 'wslc' })).rejects.toMatchObject({
				code: 'engine-too-old',
			})
		},
	)
	it('says engine-missing when wslc cannot be started or prints no version', async () => {
		const missing = runnerFor({ version: new LocalCommandError('could not start', ['ENOENT']) })
		await expect(
			resolveLocalWslcEngine({ runner: missing.runner, wslcBinary: 'wslc' }),
		).rejects.toMatchObject({ code: 'engine-missing' })
		const odd = runnerFor({ version: 'docker version' })
		await expect(
			resolveLocalWslcEngine({ runner: odd.runner, wslcBinary: 'wslc' }),
		).rejects.toMatchObject({ code: 'engine-missing' })
	})
	it('prefers an explicit binary, then the WSL install directory, then PATH', async () => {
		const seen: string[] = []
		const runner: LocalComputerCommandRunner = {
			async run(binary) {
				seen.push(binary)
				return 'wslc 3.0.1.0'
			},
		}
		const env = { ProgramFiles: 'C:\\Program Files' }
		await resolveLocalWslcEngine({ runner, wslcBinary: 'D:\\x\\wslc.exe' }, undefined, {
			platform: 'win32',
			env,
			exists: async () => true,
		})
		await resolveLocalWslcEngine({ runner }, undefined, {
			platform: 'win32',
			env,
			exists: async () => true,
		})
		await resolveLocalWslcEngine({ runner }, undefined, {
			platform: 'win32',
			env,
			exists: async () => false,
		})
		await resolveLocalWslcEngine({ runner }, undefined, { platform: 'linux', env })
		expect([...new Set(seen)]).toEqual([
			'D:\\x\\wslc.exe',
			'C:\\Program Files\\WSL\\wslc.exe',
			'wslc',
		])
	})

	it('looks in the 64-bit Program Files when a 32-bit process sees its own', async () => {
		const seen: string[] = []
		const runner: LocalComputerCommandRunner = {
			async run(binary) {
				seen.push(binary)
				return 'wslc 3.0.1.0'
			},
		}
		await resolveLocalWslcEngine({ runner }, undefined, {
			platform: 'win32',
			env: { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' },
			exists: async (path) => path === 'C:\\Program Files\\WSL\\wslc.exe',
		})
		expect(seen[0]).toBe('C:\\Program Files\\WSL\\wslc.exe')
	})

	it('says Linux container support is missing without naming the tool', async () => {
		const runner: LocalComputerCommandRunner = {
			async run() {
				throw new LocalCommandError('could not start', ['ENOENT'])
			},
		}
		const error = await resolveLocalWslcEngine({ runner }, undefined, { platform: 'linux' }).catch(
			(caught: unknown) => caught,
		)
		expect(error).toMatchObject({
			code: 'engine-missing',
			message: 'Linux container support is not installed on this PC.',
		})
	})
})

describe('typed setup errors from captured stderr', () => {
	const captured = (stderr: string) =>
		new LocalCommandError('failed (1)', extractErrorCodes(stderr))
	it.each([
		['Error code: 0x80370102\r\n', 'virtualization-off'],
		['Wsl/Service/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED\r\n', 'virtualization-off'],
		['Error code: WSLC_E_CONTAINER_DISABLED\r\n(0x8004060c)', 'blocked-by-policy'],
		['HRESULT 0x8004060C', 'blocked-by-policy'],
		['Error code: WSLC_E_SDK_UPDATE_NEEDED', 'sdk-mismatch'],
		['0x8004060b', 'sdk-mismatch'],
		["Image 'x' not found.\r\nError code: WSLC_E_IMAGE_NOT_FOUND\r\n", 'image-missing'],
	])('maps %j to %s', (stderr, code) => {
		const mapped = mapWslcFailure(captured(stderr))
		expect(mapped).toBeInstanceOf(LocalComputerSetupError)
		expect(mapped?.code).toBe(code)
		// The prose is plain: no codes and no engine output.
		expect(mapped?.message).not.toMatch(/0x|WSLC_E|HCS_E/)
	})
	it('leaves unrelated failures alone', () => {
		expect(mapWslcFailure(captured('Error code: WSLC_E_CONTAINER_NOT_FOUND'))).toBeUndefined()
		expect(mapWslcFailure(new Error('boom'))).toBeUndefined()
		expect(mapWslcFailure(captured(''))).toBeUndefined()
	})
	it('keeps only recognised codes from stderr', () => {
		expect(
			extractErrorCodes('secret path C:\\Users\\x\r\nError code: 0x8004060c WSLC_E_FOO token=abc'),
		).toEqual(['0x8004060C', 'WSLC_E_FOO'])
	})
	it('reports the image problem in the words of the app, not as a Dockerfile instruction', async () => {
		const runner: LocalComputerCommandRunner = {
			async run(_binary, args) {
				if (args[0] === 'version') return 'wslc 3.0.1.0'
				if (args[0] === 'ps') return ''
				throw new LocalCommandError('failed (1)', ['WSLC_E_IMAGE_NOT_FOUND'])
			},
		}
		const probe = await createLocalVirtualComputerProvider({ engine: 'wslc', runner }).probe?.()
		expect(probe).toMatchObject({
			ready: false,
			setupCode: 'image-missing',
			reason: expect.stringContaining('not set up'),
		})
		expect(JSON.stringify(probe)).not.toMatch(/Dockerfile|docker build/i)
	})
	it.each([
		['exits non-zero without any code, as a missing image does on wslc 3.0.1', []],
		['carries the not-found code', ['WSLC_E_IMAGE_NOT_FOUND']],
	])('treats an image inspect that %s as image-missing', async (_label, codes) => {
		const runner: LocalComputerCommandRunner = {
			async run(_binary, args) {
				if (args[0] === 'version') return 'wslc 3.0.1.0'
				if (args[0] === 'ps') return ''
				throw new LocalCommandError('failed (1)', codes)
			},
		}
		await expect(
			createLocalVirtualComputerProvider({ engine: 'wslc', runner }).acquire({
				pal,
				conversationId: 'x',
			}),
		).rejects.toMatchObject({ code: 'image-missing' })
	})
	it('does not tell the person to set up when image inspect fails for another reason', async () => {
		const crash = new LocalCommandError('failed (1)', ['0x80004005'])
		const runner: LocalComputerCommandRunner = {
			async run(_binary, args) {
				if (args[0] === 'version') return 'wslc 3.0.1.0'
				if (args[0] === 'ps') return ''
				throw crash
			},
		}
		await expect(
			createLocalVirtualComputerProvider({ engine: 'wslc', runner }).acquire({
				pal,
				conversationId: 'x',
			}),
		).rejects.toBe(crash)
	})
	it('rejects an unknown engine name', () => {
		expect(() => createLocalVirtualComputerProvider({ engine: 'lxc' as 'wslc' })).toThrow(
			'Docker, Podman or wslc',
		)
	})
})

// A real child process plays wslc and a real HTTP server plays the guest worker.
interface Harness {
	state: string
	fake: string
	servers: { execution: Server; desktop: Server }
	ports: [number, number]
	writes: string[]
	cancelled: string[]
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
	return (server.address() as AddressInfo).port
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString('utf8')
	return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

async function harness(): Promise<Harness> {
	const state = await mkdtemp(join(tmpdir(), 'namzu-fake-wslc-'))
	cleanups.push(() => rm(state, { recursive: true, force: true }))
	const fake = join(state, 'wslc')
	await copyFile(new URL('./fixtures/fake-wslc.mjs', import.meta.url), fake)
	await chmod(fake, 0o755)
	const token = async () => {
		try {
			const saved = JSON.parse(await readFile(join(state, 'state.json'), 'utf8')) as {
				containers: Record<string, { token: string }>
			}
			return Object.values(saved.containers)[0]?.token
		} catch {
			return undefined
		}
	}
	const authorized = async (request: IncomingMessage) => {
		const expected = await token()
		return expected !== undefined && request.headers.authorization === `Bearer ${expected}`
	}
	const writes: string[] = []
	const cancelled: string[] = []
	const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
	const frame = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)
	const json = (response: ServerResponse, status: number, body: unknown) => {
		response.writeHead(status, { 'content-type': 'application/json' })
		response.end(JSON.stringify(body))
	}
	const execution = createServer(async (request, response) => {
		const route = request.url ?? ''
		if (route === '/healthz') return json(response, 200, { ok: true, protocolVersion: 2 })
		if (!(await authorized(request))) return json(response, 401, { error: 'unauthorized' })
		const body = await readBody(request)
		if (route === '/executions/reserve')
			return json(response, 201, {
				ok: true,
				protocolVersion: 2,
				executionId: 'exec_00000000-0000-4000-8000-000000000001',
				leaseExpiresAt: 2_000_000_000_000,
				stdio: { version: 1, maxLifetimeMs: 2_147_000_000 },
			})
		if (route === '/execute') {
			const id = String(body.executionId)
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					streams.set(id, controller)
					controller.enqueue(frame({ type: 'stdio_started', version: 1 }))
				},
			})
			response.writeHead(200, { 'content-type': 'application/x-ndjson' })
			const reader = stream.getReader()
			for (;;) {
				const next = await reader.read()
				if (next.done) break
				response.write(next.value)
			}
			return void response.end()
		}
		if (route === '/executions/write') {
			const data = Buffer.from(String(body.data), 'base64')
			writes.push(data.toString('utf8'))
			streams.get(String(body.executionId))?.enqueue(
				frame({
					type: 'stdio_data',
					stream: 'stdout',
					data: Buffer.from(data.toString('utf8').toUpperCase()).toString('base64'),
				}),
			)
			return json(response, 200, { ok: true, bytesWritten: data.length })
		}
		if (route === '/cancel') {
			const id = String(body.executionId)
			cancelled.push(id)
			const controller = streams.get(id)
			controller?.enqueue(frame({ type: 'result', exitCode: null, timedOut: false, durationMs: 1 }))
			controller?.close()
			streams.delete(id)
			return json(response, 200, { ok: true, state: 'cancelled' })
		}
		return json(response, 404, { error: 'not found' })
	})
	const desktop = createServer(async (request, response) => {
		if (!(await authorized(request))) return json(response, 401, { error: 'unauthorized' })
		if (request.url === '/readyz')
			return json(response, 200, { protocol: 1, width: 1280, height: 800, browserReady: true })
		return json(response, 404, { error: 'not found' })
	})
	const ports: [number, number] = [await listen(execution), await listen(desktop)]
	vi.stubEnv('FAKE_WSLC_STATE', state)
	vi.stubEnv('FAKE_WSLC_PORTS', ports.join(','))
	return { state, fake, servers: { execution, desktop }, ports, writes, cancelled }
}

async function recorded(state: string) {
	return JSON.parse(await readFile(join(state, 'state.json'), 'utf8')) as {
		containers: Record<string, unknown>
		volumes: Record<string, { labels: Record<string, string> }>
		calls: { argv: string[]; hasToken: boolean }[]
	}
}

describe('wslc through a stand-in executable and worker', () => {
	it('allocates, runs with guest stdio, cancels and destroys', async () => {
		const h = await harness()
		const provider = createLocalVirtualComputerProvider({ engine: 'wslc', wslcBinary: h.fake })
		expect(await provider.probe?.()).toEqual({ ready: true })

		const lease = await provider.acquire({ pal, conversationId: 'wslc' })
		const channel = await lease.sandbox.openStdio!('cat', [])
		await channel.write(Buffer.from('hello pal'))
		const events = channel.events[Symbol.asyncIterator]()
		const first = await events.next()
		expect(first.value).toMatchObject({ stream: 'stdout' })
		expect(Buffer.from(first.value.data).toString('utf8')).toBe('HELLO PAL')
		expect(h.writes).toEqual(['hello pal'])
		await channel.close()
		expect(h.cancelled).toEqual(['exec_00000000-0000-4000-8000-000000000001'])
		expect(await events.next()).toMatchObject({ done: true })

		await lease.release()
		const state = await recorded(h.state)
		// Destroyed: the container is gone, the volume (the Pal's files) stays.
		expect(state.containers).toEqual({})
		expect(Object.keys(state.volumes)).toHaveLength(1)

		const run = state.calls.find((call) => call.argv[0] === 'run')!
		expect(run.hasToken).toBe(true)
		for (const flag of [
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--read-only',
			'--ipc=private',
			'--cgroups=disabled',
		])
			expect(run.argv).not.toContain(flag)
		for (const kept of ['--detach', '--pull=never', '--user', '--shm-size=256m', '--mount'])
			expect(run.argv).toContain(kept)
		expect(run.argv.join(' ')).not.toMatch(/--ignore|--format/)
		const verbs = state.calls.map((call) => call.argv.slice(0, 2).join(' '))
		expect(verbs).toEqual(
			expect.arrayContaining([
				'version',
				'ps -a',
				'image inspect',
				'volume inspect',
				'volume create',
				'inspect -f',
				'stop --time',
				'rm -f',
			]),
		)
		// No call ever used a template, --host, or a context.
		expect(state.calls.some((call) => call.argv.some((arg) => arg.includes('{{')))).toBe(false)
		expect(state.calls.some((call) => ['--host', 'context'].includes(call.argv[0] ?? ''))).toBe(
			false,
		)
	})

	it('reuses the Pal volume on the next allocation without --ignore', async () => {
		const h = await harness()
		const provider = createLocalVirtualComputerProvider({ engine: 'wslc', wslcBinary: h.fake })
		await (await provider.acquire({ pal, conversationId: 'one' })).release()
		await (await provider.acquire({ pal, conversationId: 'two' })).release()
		const state = await recorded(h.state)
		expect(
			state.calls.filter((call) => call.argv.slice(0, 2).join(' ') === 'volume create'),
		).toHaveLength(1)
		expect(state.calls.filter((call) => call.argv[0] === 'run')).toHaveLength(2)
	})

	it('reports a missing image as not set up, with its stable code', async () => {
		const h = await harness()
		vi.stubEnv('FAKE_WSLC_IMAGE', 'something-else:1')
		const provider = createLocalVirtualComputerProvider({ engine: 'wslc', wslcBinary: h.fake })
		await expect(provider.acquire({ pal, conversationId: 'x' })).rejects.toMatchObject({
			code: 'image-missing',
			message: expect.stringContaining('not set up'),
		})
		expect((await recorded(h.state)).calls.some((call) => call.argv[0] === 'run')).toBe(false)
	})

	it.each([
		['0x80370102', 'virtualization-off'],
		['0x8004060C', 'blocked-by-policy'],
		['0x8004060B', 'sdk-mismatch'],
	])('turns a real process failure carrying %s into %s', async (code, expected) => {
		const h = await harness()
		vi.stubEnv('FAKE_WSLC_SESSION_ERROR', code)
		const provider = createLocalVirtualComputerProvider({ engine: 'wslc', wslcBinary: h.fake })
		const probe = await provider.probe?.()
		expect(probe?.ready).toBe(false)
		// The probe carries the code, so an application chooses its words by it.
		expect(probe).toMatchObject({ setupCode: expected })
		await expect(provider.acquire({ pal, conversationId: 'x' })).rejects.toMatchObject({
			code: expected,
		})
	})

	it('gives a failure that is not a setup error no setup code', async () => {
		const h = await harness()
		const provider = createLocalVirtualComputerProvider({
			engine: 'wslc',
			wslcBinary: h.fake,
			runner: {
				run: async () => {
					throw new Error('The engine response exceeded its size limit')
				},
			},
		})
		const probe = await provider.probe?.()
		expect(probe?.ready).toBe(false)
		expect((probe as { setupCode?: string }).setupCode).toBeUndefined()
		expect(probe?.reason).toContain('Windows Linux container support')
	})

	it('says engine-missing when the binary does not exist', async () => {
		const provider = createLocalVirtualComputerProvider({
			engine: 'wslc',
			wslcBinary: join(tmpdir(), 'namzu-no-such-wslc'),
		})
		await expect(provider.acquire({ pal, conversationId: 'x' })).rejects.toMatchObject({
			code: 'engine-missing',
		})
	})

	it('refuses a runtime older than the floor', async () => {
		const h = await harness()
		vi.stubEnv('FAKE_WSLC_VERSION', 'wslc 2.9.2.0')
		const provider = createLocalVirtualComputerProvider({ engine: 'wslc', wslcBinary: h.fake })
		await expect(provider.acquire({ pal, conversationId: 'x' })).rejects.toMatchObject({
			code: 'engine-too-old',
		})
	})
})
