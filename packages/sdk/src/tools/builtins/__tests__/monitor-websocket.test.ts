import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

import {
	BackgroundJobRegistry,
	type MonitorEvent,
	bindOwner,
} from '../../../runtime/jobs/registry.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { BackgroundJobRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { DISABLE_BACKGROUND_TASKS_ENV } from '../bash.js'
import { MONITOR_WEBSOCKET_WEB_OFF, MonitorTool, createMonitorTool } from '../monitor.js'

/**
 * The `ws` arm of the monitor tool: what it accepts, what it refuses before it
 * connects, how an approval describes it, and one run against a real server.
 */

const WEB = { fetch: { fetch: async () => ({}) } } as unknown as NonNullable<ToolContext['web']>

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as TurnId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		web: WEB,
		...overrides,
	}
}

function fakeJobs() {
	const startMonitor = vi.fn(() => ({
		job: { id: 'b00000001', status: 'running' },
		timeoutMs: 90_000,
	}))
	const jobs = {
		start: vi.fn(),
		startMonitor: vi.fn(),
		startWebSocketMonitor: startMonitor,
		awaitStarted: vi.fn(async () => ({})),
	} as unknown as BackgroundJobRegistryRef
	return { jobs, startMonitor }
}

const parse = (input: Record<string, unknown>) => MonitorTool.inputSchema.parse(input)
const ws = (extra: Record<string, unknown> = {}) => ({
	description: 'feed',
	ws: { url: 'wss://events.example/stream', ...extra },
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('exactly one source', () => {
	it('accepts a command or a ws, and not neither or both', () => {
		expect(parse({ description: 'd', command: 'tail -f x' }).command).toBe('tail -f x')
		expect(parse(ws()).ws?.url).toBe('wss://events.example/stream')
		expect(() => parse({ description: 'd' })).toThrow(/exactly one of command and ws/)
		expect(() =>
			parse({ description: 'd', command: 'tail -f x', ws: { url: 'wss://events.example/' } }),
		).toThrow(/exactly one of command and ws/)
	})

	it('refuses a URL that is not a plain ws or wss address', () => {
		for (const url of [
			'https://events.example/',
			'wss://user:pw@events.example/',
			'wss://events.example/a b',
			'wss://exämple.example/',
			`wss://events.example/${'a'.repeat(2048)}`,
		]) {
			expect(() => parse({ description: 'd', ws: { url } }), url).toThrow()
		}
	})

	it('refuses subprotocols that are not unique tokens, or that are too many', () => {
		expect(parse(ws({ protocols: ['graphql-ws'] })).ws?.protocols).toEqual(['graphql-ws'])
		expect(() => parse(ws({ protocols: ['a b'] }))).toThrow()
		expect(() => parse(ws({ protocols: ['x', 'x'] }))).toThrow()
		expect(() => parse(ws({ protocols: Array.from({ length: 17 }, (_, i) => `p${i}`) }))).toThrow()
	})

	it('has no way for the model to set a header or an address', () => {
		const parsed = parse(
			ws({ headers: { authorization: 'Bearer x' }, addresses: ['127.0.0.1'], resolve: 'x' }),
		)
		expect(parsed.ws).toEqual({ url: 'wss://events.example/stream' })
	})
})

describe('a WebSocket call is its own kind of call', () => {
	it('is never read-only, is destructive for nothing, and always needs a person', () => {
		const input = parse(ws())
		expect(MonitorTool.isReadOnly?.(input)).toBe(false)
		expect(MonitorTool.isDestructive?.(input)).toBe(false)
		expect(MonitorTool.requiresApproval?.(input)).toBe(true)
		// The existing command call is reviewed exactly as it was.
		expect(MonitorTool.requiresApproval?.(parse({ description: 'd', command: 'tail -f x' }))).toBe(
			false,
		)
	})

	it('says it may reach the network as well as run a shell', () => {
		expect(MonitorTool.permissions).toEqual(['shell_execute', 'network_access'])
	})

	it('shows what will happen: the URL and the subprotocols', () => {
		expect(MonitorTool.presentCall?.(parse(ws({ protocols: ['graphql-ws', 'v2'] })))).toEqual({
			kind: 'generic',
			label:
				'Monitor · feed · WebSocket wss://events.example/stream (subprotocols: graphql-ws, v2)',
		})
		expect(MonitorTool.presentCall?.(parse(ws()))).toEqual({
			kind: 'generic',
			label: 'Monitor · feed · WebSocket wss://events.example/stream',
		})
	})
})

describe('what is refused before a connection is opened', () => {
	it('refuses private addresses and never starts a job', async () => {
		const { jobs, startMonitor } = fakeJobs()
		for (const url of [
			'ws://127.0.0.1:9/feed',
			'ws://[::1]/feed',
			'ws://169.254.169.254/latest/meta-data',
			'ws://192.168.1.10/feed',
		]) {
			const result = await MonitorTool.execute(
				parse({ description: 'd', ws: { url } }),
				context({ backgroundJobs: jobs }),
			)
			expect(result.success, url).toBe(false)
			expect(result.error, url).toMatch(/Refused .* inside this host's own network/)
		}
		expect(startMonitor).not.toHaveBeenCalled()
	})

	it('refuses a name that resolves inside, or not at all, through the resolver it was built with', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const tool = createMonitorTool({
			webSocket: {
				resolve: async (name) => {
					if (name === 'inside.example') return ['10.0.0.9']
					if (name === 'mixed.example') return ['93.184.216.34', '127.0.0.1']
					throw new Error('ENOTFOUND')
				},
			},
		})
		for (const [host, why] of [
			['inside.example', /resolves to 10\.0\.0\.9/],
			['mixed.example', /resolves to 127\.0\.0\.1/],
			['gone.example', /could not be resolved/],
		] as const) {
			const result = await tool.execute(
				tool.inputSchema.parse({ description: 'd', ws: { url: `wss://${host}/s` } }),
				context({ backgroundJobs: jobs }),
			)
			expect(result.success, host).toBe(false)
			expect(result.error, host).toMatch(why)
		}
		expect(startMonitor).not.toHaveBeenCalled()
	})

	it('refuses when the host has web access switched off', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const { web: _web, ...withoutWeb } = context({ backgroundJobs: jobs })
		const result = await MonitorTool.execute(parse(ws()), withoutWeb)
		expect(result).toMatchObject({ success: false, error: MONITOR_WEBSOCKET_WEB_OFF })
		expect(startMonitor).not.toHaveBeenCalled()
	})

	it('refuses under a sandbox that blocks the network unless its live policy allows the host', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const resolve = async () => ['93.184.216.34']
		const tool = createMonitorTool({ webSocket: { resolve } })
		const input = tool.inputSchema.parse({
			description: 'd',
			ws: { url: 'wss://events.example/s' },
		})
		const sandbox = (allowedHosts?: string[]) =>
			({
				environment: 'linux-bwrap',
				spawnDetached: () => {
					throw new Error('not used')
				},
				...(allowedHosts ? { networkPolicy: { allowedHosts } } : {}),
			}) as unknown as Sandbox

		const refused = await tool.execute(input, context({ backgroundJobs: jobs, sandbox: sandbox() }))
		expect(refused.success).toBe(false)
		expect(refused.error).toMatch(/connects from the host, outside this turn's sandbox/)
		expect(startMonitor).not.toHaveBeenCalled()

		const allowed = await tool.execute(
			input,
			context({ backgroundJobs: jobs, sandbox: sandbox(['events.example']) }),
		)
		expect(allowed.success).toBe(true)
		expect(startMonitor).toHaveBeenCalledTimes(1)
	})

	it('is refused by the background-task switch like any monitor', async () => {
		vi.stubEnv(DISABLE_BACKGROUND_TASKS_ENV, '1')
		const { jobs } = fakeJobs()
		const result = await MonitorTool.execute(parse(ws()), context({ backgroundJobs: jobs }))
		expect(result.success).toBe(false)
		expect(result.error).toContain(DISABLE_BACKGROUND_TASKS_ENV)
	})
})

describe('a WebSocket monitor, started by the tool', () => {
	const servers: WebSocketServer[] = []
	afterEach(async () => {
		for (const server of servers.splice(0)) {
			for (const client of server.clients) client.terminate()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	it('connects to the server, passes the subprotocol, and delivers its frames as events', async () => {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		servers.push(server)
		await new Promise<void>((resolve) => server.once('listening', resolve))
		const port = (server.address() as AddressInfo).port
		const connected = new Promise<{ protocol: string; headers: string[] }>((resolve) => {
			server.on('connection', (socket, request) => {
				socket.send('ready\nsteady')
				resolve({
					protocol: socket.protocol,
					headers: Object.keys(request.headers),
				})
			})
		})

		const registry = new BackgroundJobRegistry()
		const bound = bindOwner(registry, 'turn-1')
		const heard = new Promise<MonitorEvent>((resolve) => registry.onMonitorEvent(resolve))
		// For tests only: this server is on this machine.
		const tool = createMonitorTool({ webSocket: { allowPrivateAddresses: true } })

		const result = await tool.execute(
			tool.inputSchema.parse({
				description: 'local feed',
				ws: { url: `ws://127.0.0.1:${port}/feed`, protocols: ['v1.test'] },
				timeout_ms: 60_000,
			}),
			context({ backgroundJobs: bound }),
		)

		expect(result.success).toBe(true)
		expect(result.output).toMatch(
			/^WebSocket monitor started \(job .*, expires in 1m unless the server closes/,
		)
		expect(result.data).toMatchObject({ monitor: true, timeoutMs: 60_000, transport: 'websocket' })
		const seen = await connected
		expect(seen.protocol).toBe('v1.test')
		// No header the model could set was sent beyond what the handshake needs.
		expect(seen.headers).not.toContain('authorization')
		expect(seen.headers).not.toContain('cookie')
		const event = await heard
		expect(event).toMatchObject({
			kind: 'output',
			text: 'ready\nsteady',
			description: 'local feed',
		})
		const job = bound.list()[0]
		expect(job?.command).toBe(`websocket ws://127.0.0.1:${port}/feed`)
		// `job list` and the footers show a monitor by what it watches.
		expect(job?.kind).toBe('monitor')
		await bound.kill(job?.id ?? '')
	})
})

describe('a host that only starts command monitors', () => {
	it('is told so in plain words, and is never handed a WebSocket target', async () => {
		const { jobs, startMonitor } = fakeJobs()
		const commandOnly = { ...jobs, startWebSocketMonitor: undefined } as BackgroundJobRegistryRef
		const result = await MonitorTool.execute(
			parse({ description: 'd', ws: { url: 'wss://93.184.216.34/stream' } }),
			context({ backgroundJobs: commandOnly }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/cannot start a WebSocket monitor/)
		expect(startMonitor).not.toHaveBeenCalled()
		expect((commandOnly.startMonitor as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
	})
})

describe('the refusal while web access is off', () => {
	const noWeb = { backgroundJobs: fakeJobs().jobs, web: undefined }

	it("adds the host's own way to turn it on, when the host gave one", async () => {
		const tool = createMonitorTool({ webAccessHint: 'Set web.fetch: true in the config.' })
		const result = await tool.execute(
			tool.inputSchema.parse({ description: 'd', ws: { url: 'wss://93.184.216.34/stream' } }),
			context(noWeb),
		)
		expect(result.error).toBe(`${MONITOR_WEBSOCKET_WEB_OFF} Set web.fetch: true in the config.`)
	})

	it('says only that it is off when the host gave no hint', async () => {
		const result = await MonitorTool.execute(
			parse({ description: 'd', ws: { url: 'wss://93.184.216.34/stream' } }),
			context(noWeb),
		)
		expect(result.error).toBe(MONITOR_WEBSOCKET_WEB_OFF)
	})
})
