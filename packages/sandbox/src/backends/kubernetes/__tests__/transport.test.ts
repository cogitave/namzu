/**
 * `KubernetesAgentTransport` (`../transport.ts`) against the REAL guest
 * agent (`agent/agent.cjs`) listening on a real loopback TCP socket in
 * preset-token mode (`NAMZU_AGENT_TCP_PORT` + `NAMZU_AGENT_BIND_TOKEN`) —
 * the exact mode a routed pod-network deployment runs in.
 *
 * These prove the `tcp` arm end to end: dial, token-in-envelope, framing,
 * and the reuse of `VsockAgentTransport`'s per-call dial (fresh
 * connection every request, DNS re-resolved every time), plus the
 * kubernetes-specific additions — the pre-auth frame-size guard and the
 * per-phase timing callback — that only make sense for a routed,
 * credentialed transport.
 */

import dns from 'node:dns'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	AgentPreauthFrameTooLargeError,
	TCP_PREAUTH_FRAME_LIMIT_BYTES,
	__framing,
} from '../../firecracker/transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'

import { KubernetesAgentTransport, type KubernetesTransportTiming } from '../transport.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

interface AgentModule {
	FIRECRACKER_AGENT_PROTOCOL_VERSION: number
	startListening(): Promise<Server>
}

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'
const WRONG_UID = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

const MANAGED_ENV = AGENT_ENV_KEYS

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) {
		// Unset, not emptied: the agent reads these straight off
		// process.env, where an empty string is not the same as absent.
		delete process.env[key]
	}
}

let workDir: string
let listener: Server | undefined
let saved: Record<string, string | undefined>

/** Load a FRESH agent module, so module-level bind-token state never leaks. */
function loadAgent(): AgentModule {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	return require_(AGENT_PATH) as AgentModule
}

async function startAgent(token = POD_UID): Promise<{ agent: AgentModule; port: number }> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = token
	const agent = loadAgent()
	listener = await agent.startListening()
	const { port } = listener.address() as AddressInfo
	return { agent, port }
}

beforeEach(() => {
	saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]))
	clearEnv(MANAGED_ENV)
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-tcp-transport-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	clearEnv(MANAGED_ENV)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe('KubernetesAgentTransport over a real TCP-listening agent', () => {
	it('serves a healthz round trip with no token required', async () => {
		const { agent, port } = await startAgent()
		const transport = new KubernetesAgentTransport({ kind: 'tcp', host: '127.0.0.1', port })

		expect(await transport.healthz()).toBe(true)
		expect(agent.FIRECRACKER_AGENT_PROTOCOL_VERSION).toBe(2)
	})

	it('reserves an execution', async () => {
		const { port } = await startAgent()
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		const reservation = (await transport.reserve()) as {
			ok: boolean
			protocolVersion: number
			executionId: string
			leaseExpiresAt: number
		}
		expect(reservation.ok).toBe(true)
		expect(reservation.protocolVersion).toBe(2)
		expect(reservation.executionId).toMatch(/^exec_/)
		expect(reservation.leaseExpiresAt).toBeGreaterThan(Date.now())
	})

	it('round-trips write-file/read-file as base64 through the workspace jail', async () => {
		const { port } = await startAgent()
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		const payload = Buffer.from([0x00, 0xff, 0x10, 0x42, 0x00, 0x99, 0xfe])
		await transport.writeFile('sub/dir/blob.bin', payload)
		const read = await transport.readFile('sub/dir/blob.bin')
		expect(read.equals(payload)).toBe(true)
	})

	// The consequence of the credential riding in the envelope rather than a
	// handshake, combined with a fresh dial per call: every tcp request IS
	// its connection's first (unauthenticated-until-parsed) frame, so the
	// guest's pre-auth frame ceiling is the effective per-request budget,
	// not a one-time cost. This body clears it with room to spare.
	it('admits a write-file body near, but under, the pre-auth frame ceiling', async () => {
		const { port } = await startAgent()
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		// ~5.5 MiB raw -> ~7.3 MiB base64 + envelope overhead -> comfortably
		// under the 8 MiB default ceiling, but not by an order of magnitude:
		// this is the size a caller with a real file would actually hit.
		const body = Buffer.alloc(5.5 * 1024 * 1024, 0x61)

		await transport.writeFile('near-limit.bin', body)
		const read = await transport.readFile('near-limit.bin')
		expect(read.length).toBe(body.length)
	})

	it('refuses a write-file body over the pre-auth ceiling before dialing', async () => {
		const { port } = await startAgent()
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		// ~7 MiB raw -> ~9.3 MiB base64 -> clearly over the 8 MiB ceiling.
		const body = Buffer.alloc(7 * 1024 * 1024, 0x62)

		let caught: unknown
		try {
			await transport.writeFile('too-big.bin', body)
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(AgentPreauthFrameTooLargeError)
		expect((caught as Error).message).toContain(String(TCP_PREAUTH_FRAME_LIMIT_BYTES))
		// No dial: the check runs before net.connect, so the agent never saw
		// the attempt at all.
		expect(connections).toBe(0)
	})

	it('refuses a wrong token with a named unauthorized error', async () => {
		const { port } = await startAgent(POD_UID)
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: WRONG_UID,
		})

		let caught: unknown
		try {
			await transport.reserve()
		} catch (error) {
			caught = error
		}
		expect((caught as Error)?.name).toBe('KubernetesAgentUnauthorizedError')
		expect((caught as Error)?.message).toMatch(/unauthorized/i)
	})

	it('opens a fresh connection per call — two sequential calls, two server connections', async () => {
		const { port } = await startAgent()
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		expect(await transport.healthz()).toBe(true)
		expect(await transport.healthz()).toBe(true)
		expect(connections).toBe(2)
	})

	describe.skipIf(IS_WINDOWS)('exec and tcp-connect', () => {
		it('streams stdout/stderr/result from exec()', async () => {
			const { port } = await startAgent()
			const transport = new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port,
				token: POD_UID,
			})

			const chunks: string[] = []
			const result = await transport.exec(
				'/bin/sh',
				['-c', 'echo out-line; echo err-line 1>&2; exit 3'],
				{
					onOutput: (chunk) => chunks.push(chunk.data),
				},
			)
			expect(result.stdout).toContain('out-line')
			expect(result.stderr).toContain('err-line')
			expect(result.exitCode).toBe(3)
			expect(result.timedOut).toBe(false)
			expect(chunks.join('')).toContain('out-line')
		})

		it('forwards a bidirectional guest-loopback TCP stream', async () => {
			const { port } = await startAgent()
			const upstream = createServer((socket) => {
				socket.once('data', (chunk) => socket.end(Buffer.concat([Buffer.from('reply:'), chunk])))
			})
			await new Promise<void>((resolve, reject) => {
				upstream.once('error', reject)
				upstream.listen(0, '127.0.0.1', resolve)
			})
			try {
				const address = upstream.address()
				if (!address || typeof address === 'string') throw new Error('missing TCP test address')
				const transport = new KubernetesAgentTransport({
					kind: 'tcp',
					host: '127.0.0.1',
					port,
					token: POD_UID,
				})
				const connection = await transport.openTcpConnection({ port: address.port })
				let output = ''
				const dispose = connection.onData((chunk) => {
					output += Buffer.from(chunk).toString('utf8')
				})
				expect(connection.write('hello')).toBe(true)
				await expect(connection.closed).resolves.toBeUndefined()
				expect(output).toBe('reply:hello')
				dispose()
			} finally {
				await new Promise<void>((resolve) => upstream.close(() => resolve()))
			}
		})

		it('refuses a non-loopback tcp-connect host', async () => {
			const { port } = await startAgent()
			const transport = new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port,
				token: POD_UID,
			})
			// The type only admits loopback hosts; a JS caller can still send
			// anything, so the refusal must be enforced at runtime too.
			await expect(
				transport.openTcpConnection({ host: '10.0.0.5', port: 80 } as never),
			).rejects.toThrow(/loopback/)
		})
	})

	describe.skipIf(process.platform !== 'linux')('terminal', () => {
		it('provides a real TTY with ordered input, resize, output, and exit', async () => {
			const { port } = await startAgent()
			const transport = new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port,
				token: POD_UID,
			})
			const terminal = await transport.openTerminal({
				command: '/bin/sh',
				args: ['-l'],
				cwd: workDir,
				size: { cols: 101, rows: 31 },
			})
			let output = ''
			const unsubscribe = terminal.onData((chunk) => {
				output += chunk
			})

			terminal.write(
				'if [ -t 0 ] && [ -t 1 ]; then echo __REAL_PTY__; else echo __NOT_A_PTY__; fi; stty size\n',
			)
			await vi.waitFor(() => expect(output).toContain('__REAL_PTY__'))
			await vi.waitFor(() => expect(output).toContain('31 101'))

			terminal.resize({ cols: 120, rows: 40 })
			terminal.write('sleep 0.1; stty size; echo __RESIZED__; exit 7\n')
			await vi.waitFor(() => expect(output).toContain('__RESIZED__'))
			await vi.waitFor(() => expect(output).toContain('40 120'))
			await expect(terminal.exited).resolves.toMatchObject({ exitCode: 7 })
			unsubscribe()
		})
	})

	describe.skipIf(IS_WINDOWS)('per-phase timing', () => {
		it('fires once with four durations and never the token', async () => {
			const { port } = await startAgent()
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: '127.0.0.1', port, token: POD_UID },
				{
					onTiming: (timing) => {
						timings.push(timing)
					},
				},
			)
			const timings: KubernetesTransportTiming[] = []

			await transport.exec('/bin/true')

			expect(timings).toHaveLength(1)
			const timing = timings[0] as KubernetesTransportTiming
			expect(typeof timing.dialMs).toBe('number')
			expect(typeof timing.reserveMs).toBe('number')
			expect(typeof timing.executeMs).toBe('number')
			expect(typeof timing.drainMs).toBe('number')
			expect(timing.dialMs).toBeGreaterThanOrEqual(0)
			expect(timing.reserveMs).toBeGreaterThanOrEqual(0)
			expect(timing.executeMs).toBeGreaterThanOrEqual(0)
			expect(timing.drainMs).toBeGreaterThanOrEqual(0)
			expect(Object.keys(timing).sort()).toEqual(['dialMs', 'drainMs', 'executeMs', 'reserveMs'])
			expect(JSON.stringify(timing)).not.toContain(POD_UID)
		})
	})
})

describe('KubernetesAgentTransport connect failure handling', () => {
	// 192.0.2.1 (TEST-NET-1, RFC 5737) is reserved and never assigned, so a
	// connect toward it is silently dropped rather than refused — a real
	// "the peer never answers" hang, not a fast ECONNREFUSED. That is the
	// one condition this transport's own connect timer, not the OS, must
	// catch.
	const BLACKHOLE_HOST = '192.0.2.1'

	function spyOnSockets(): { sockets: net.Socket[]; restore: () => void } {
		const sockets: net.Socket[] = []
		const original = net.connect.bind(net)
		const spy = vi.spyOn(net, 'connect').mockImplementation(((...args: unknown[]) => {
			const socket = (original as (...a: unknown[]) => net.Socket)(...args)
			sockets.push(socket)
			return socket
		}) as typeof net.connect)
		return { sockets, restore: () => spy.mockRestore() }
	}

	it('rejects a connect timeout promptly and destroys the socket', async () => {
		const { sockets, restore } = spyOnSockets()
		try {
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: BLACKHOLE_HOST, port: 9, token: POD_UID },
				{ connectTimeoutMs: 150, connectRetryBudgetMs: 150, connectRetryIntervalMs: 50 },
			)

			const startedAt = performance.now()
			expect(await transport.healthz()).toBe(false)
			expect(performance.now() - startedAt).toBeLessThan(2_000)
			expect(sockets.length).toBeGreaterThan(0)
			for (const socket of sockets) expect(socket.destroyed).toBe(true)
		} finally {
			restore()
		}
	})

	it('rejects an aborted dial promptly and destroys the socket', async () => {
		const { sockets, restore } = spyOnSockets()
		try {
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: BLACKHOLE_HOST, port: 9, token: POD_UID },
				{ connectTimeoutMs: 10_000, connectRetryBudgetMs: 10_000 },
			)
			const controller = new AbortController()
			const startedAt = performance.now()
			setTimeout(() => controller.abort(new Error('caller cancelled')), 50)

			await expect(transport.healthz(controller.signal)).rejects.toThrow(/cancelled/)
			expect(performance.now() - startedAt).toBeLessThan(1_000)
			expect(sockets.length).toBeGreaterThan(0)
			for (const socket of sockets) expect(socket.destroyed).toBe(true)
		} finally {
			restore()
		}
	})
})

describe('KubernetesAgentTransport DNS re-resolution', () => {
	let serverA: Server | undefined
	let serverB: Server | undefined
	let originalLookup: typeof dns.lookup

	afterEach(async () => {
		dns.lookup = originalLookup
		if (serverA) await new Promise<void>((resolve) => serverA?.close(() => resolve()))
		if (serverB) await new Promise<void>((resolve) => serverB?.close(() => resolve()))
		serverA = undefined
		serverB = undefined
	})

	it('reaches a different target when the hostname resolves differently between calls', async () => {
		const SHARED_PORT = 34_217
		const reply = (label: string) => (socket: Socket) => {
			const reader = new __framing.FrameReader()
			socket.on('data', (chunk: Buffer) => {
				if (reader.push(chunk)[0] === undefined) return
				socket.end(
					__framing.frame(
						JSON.stringify({ ok: true, content: Buffer.from(label).toString('base64') }),
					),
				)
			})
		}
		serverA = createServer(reply('server-a'))
		serverB = createServer(reply('server-b'))
		await new Promise<void>((resolve, reject) => {
			serverA?.once('error', reject)
			serverA?.listen(SHARED_PORT, '127.0.0.1', resolve)
		})
		await new Promise<void>((resolve, reject) => {
			serverB?.once('error', reject)
			serverB?.listen(SHARED_PORT, '127.0.0.2', resolve)
		})

		originalLookup = dns.lookup
		let call = 0
		dns.lookup = ((_hostname: string, options: any, callback?: any) => {
			call += 1
			const cb = typeof options === 'function' ? options : callback
			const address = call === 1 ? '127.0.0.1' : '127.0.0.2'
			if (options && typeof options === 'object' && options.all) {
				cb(null, [{ address, family: 4 }])
			} else {
				cb(null, address, 4)
			}
		}) as any

		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: 'agent.fake-service.svc.cluster.local',
			port: SHARED_PORT,
			token: POD_UID,
		})

		const first = await transport.readFile('unused')
		const second = await transport.readFile('unused')
		expect(first.toString('utf8')).toBe('server-a')
		expect(second.toString('utf8')).toBe('server-b')
	})
})
