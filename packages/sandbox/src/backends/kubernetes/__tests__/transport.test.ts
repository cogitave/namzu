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

import { randomUUID } from 'node:crypto'
import dns from 'node:dns'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
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

import {
	type KubernetesAgentHandle,
	KubernetesAgentTransport,
	type KubernetesTransportTiming,
} from '../transport.js'

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

	// The ceiling still bounds every OTHER op — only `write-file` learned to
	// span frames. An oversized `execute` envelope is refused client-side,
	// before a connection the guest would close anyway is opened at all.
	it('refuses an oversized non-write request over the pre-auth ceiling before dialing', async () => {
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

		// 9 MiB of environment, clearly over the 8 MiB ceiling once enveloped.
		let caught: unknown
		try {
			await transport.openTerminal({
				command: '/bin/sh',
				env: { HUGE: 'x'.repeat(9 * 1024 * 1024) },
				size: { cols: 80, rows: 24 },
			})
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(AgentPreauthFrameTooLargeError)
		expect((caught as Error).message).toContain(String(TCP_PREAUTH_FRAME_LIMIT_BYTES))
		// No dial: the check runs before net.connect, so the agent never saw
		// the attempt at all.
		expect(connections).toBe(0)
	})

	// `write-file` is the exception, and the whole point of this batch: a
	// body past the ceiling is split into parts and reassembled under an
	// atomic rename. `write-file-parts.test.ts` owns the mechanism.
	it('writes a body over the pre-auth ceiling instead of refusing it', async () => {
		const { port } = await startAgent()
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		// ~7 MiB raw -> ~9.3 MiB base64 -> clearly over the 8 MiB ceiling.
		const body = Buffer.alloc(7 * 1024 * 1024, 0x62)

		await transport.writeFile('was-too-big.bin', body)
		const read = await transport.readFile('was-too-big.bin')
		expect(read.length).toBe(body.length)
		expect(read.equals(body)).toBe(true)
	}, 30_000)

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

	// `reserve` refusing a wrong token was never enough on its own. The
	// shared controller RETRIES a failed cancellation for its whole confirm
	// window and then reports the cancellation UNCONFIRMED — which retires
	// the sandbox — so a refusal read as a transport blip would describe a
	// wrong credential as an ambiguous outcome, after spending the window.
	it('refuses a wrong token on cancel-execution with the same named error as reserve', async () => {
		const { port } = await startAgent(POD_UID)
		const authorized = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})
		const { executionId } = (await authorized.reserve()) as { executionId: string }

		const wrong = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: WRONG_UID,
		})
		let caught: unknown
		try {
			await wrong.cancel(executionId)
		} catch (error) {
			caught = error
		}
		expect((caught as Error)?.name).toBe('KubernetesAgentUnauthorizedError')
		// And the authorized caller can still cancel the same execution: the
		// refusal was about the credential, not about the execution.
		expect(await authorized.cancel(executionId)).toMatchObject({ ok: true })
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

/**
 * A pod replaced underneath a live handle, on EVERY operation the Sandbox
 * surface dials the guest with — `agentAddress: 'pod-ip'`'s one re-read.
 *
 * The whole point of the mode is a handle that carries a literal IP, and a
 * literal IP dies with its pod: an eviction, a node drain or a resume gives
 * the workspace a new pod at a new address with a new bind token, and the
 * only symptom on the host is that the next dial is refused. So a dial that
 * fails at CONNECT re-reads the live pod once and, if the uid changed,
 * follows it — address and token together — and retries.
 *
 * Every case here is driven through the REAL agent, and the agent is bound to
 * the REPLACEMENT pod's token. A transport that retried without taking the
 * new token would be answered `unauthorized`, so "it succeeded" is evidence
 * that both halves of the handle moved.
 *
 * `exec()` is the case this suite exists for and the one that must run with
 * the timing options the backend actually builds — none. It is the only
 * operation whose failure does not carry the dial's own error: the shared
 * {@link RemoteExecutionController} bounds its control requests by RACING
 * them against a 2s timer, so a dial still inside its 30s connect-retry
 * budget is reported as a reservation that took too long and the connect
 * failure is discarded, not wrapped. Every other operation hands back the
 * dial's error and so is dialed here with a spent retry budget, to keep the
 * suite fast rather than because the distinction matters to them.
 */
describe.skipIf(IS_WINDOWS)('a connect failure follows a replaced pod', () => {
	/** The uid the controller's replacement pod carries — a new bind token. */
	const REPLACEMENT_UID = 'b7a1c4d0-3e52-4f61-9a08-1d2c3b4a5e6f'
	/** A dial that gives up at once: no budget to spend on a dead address. */
	const SPENT_BUDGET = { connectTimeoutMs: 200, connectRetryBudgetMs: 0 } as const

	/** A port nothing is listening on — the pod that was taken away. */
	async function closedPort(): Promise<number> {
		const probe = createServer()
		await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
		const { port } = probe.address() as AddressInfo
		await new Promise<void>((resolve) => probe.close(() => resolve()))
		return port
	}

	/**
	 * The OTHER half of "the pod is gone", and the half a routed pod network
	 * actually produces: a released pod IP black-holes the SYN or waits out
	 * ARP instead of answering it. 192.0.2.1 (TEST-NET-1, RFC 5737) is
	 * reserved and never assigned, so a connect toward it is dropped rather
	 * than refused and the attempt runs to this transport's own connect
	 * timer. A closed LOOPBACK port answers ECONNREFUSED in microseconds, so
	 * it can only ever prove the fast half.
	 */
	const BLACKHOLE_ADDRESS = { host: '192.0.2.1', port: 9 } as const

	/**
	 * A transport still pointing at the pod that is gone, whose one re-read
	 * answers with the pod the controller brought up in its place.
	 *
	 * `stale` is what the dead pod's address does to a connect: a closed
	 * loopback port (the default) refuses it at once, {@link
	 * BLACKHOLE_ADDRESS} never answers at all.
	 */
	async function staleHandle(
		agentPort: number,
		options: Record<string, unknown> = {},
		stale?: { host: string; port: number },
	): Promise<{ transport: KubernetesAgentTransport; refreshHandle: ReturnType<typeof vi.fn> }> {
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentHandle> => ({
				kind: 'tcp',
				host: '127.0.0.1',
				port: agentPort,
				token: REPLACEMENT_UID,
			}),
		)
		const dead = stale ?? { host: '127.0.0.1', port: await closedPort() }
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: dead.host, port: dead.port, token: POD_UID },
			{ ...options, refreshHandle },
		)
		return { transport, refreshHandle }
	}

	/** Every abandoned part file left anywhere under the workspace. */
	function strayPartFiles(dir: string = workDir): string[] {
		const out: string[] = []
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) out.push(...strayPartFiles(full))
			else if (entry.name.startsWith('.namzu-write-')) out.push(full)
		}
		return out
	}

	it('rebinds exec(), with the timing options the backend actually builds', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		const { transport, refreshHandle } = await staleHandle(port)

		const result = await transport.exec('/bin/sh', ['-c', 'echo ran-on-the-new-pod'])

		expect(result.stdout).toContain('ran-on-the-new-pod')
		expect(result.exitCode).toBe(0)
		// Exactly one re-read for the call, and the handle moved with it.
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		expect(transport.address).toEqual({ host: '127.0.0.1', port })
	}, 20_000)

	/**
	 * The failure shape the docs name as characteristic of `'pod-ip'`, and
	 * the one `exec()` cannot classify from its error at all.
	 *
	 * The default connect timer is 5s and the execution controller bounds a
	 * control request at 2s, so the bound fires FIRST: the caller is handed
	 * the bound's bare `… reservation exceeded 2000ms` Error while the
	 * connect attempt it aborted had not yet failed. Nothing about that error
	 * says a dial was involved, and a watch that only records FAILED attempts
	 * has not been written to either — which is why the watch records that a
	 * connect was ATTEMPTED.
	 *
	 * Timing overrides would hide exactly that: any `connectTimeoutMs` under
	 * the 2s bound turns this back into the refused case above. So this one
	 * runs on the options the backend actually builds — none.
	 */
	it('rebinds exec() when the dial is BLACK-HOLED rather than refused', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		const { transport, refreshHandle } = await staleHandle(port, {}, BLACKHOLE_ADDRESS)

		const result = await transport.exec('/bin/sh', ['-c', 'echo followed-the-replacement'])

		expect(result.stdout).toContain('followed-the-replacement')
		expect(result.exitCode).toBe(0)
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		expect(transport.address).toEqual({ host: '127.0.0.1', port })
	}, 30_000)

	it('rebinds readFile()', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		// Seeded through the replacement pod's own token: the disk followed
		// the workspace, which is what a resume actually looks like.
		await new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: REPLACEMENT_UID,
		}).writeFile('carried-over.txt', Buffer.from('from the replacement pod'))
		const { transport, refreshHandle } = await staleHandle(port, SPENT_BUDGET)

		const read = await transport.readFile('carried-over.txt')

		expect(read.toString('utf8')).toBe('from the replacement pod')
		expect(refreshHandle).toHaveBeenCalledTimes(1)
	})

	it('rebinds writeFile()', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		const { transport, refreshHandle } = await staleHandle(port, SPENT_BUDGET)

		await transport.writeFile('written-after-the-rebind.txt', Buffer.from('landed'))

		expect(readFileSync(join(workDir, 'written-after-the-rebind.txt'), 'utf8')).toBe('landed')
		expect(refreshHandle).toHaveBeenCalledTimes(1)
	})

	it('rebinds a writeFile() large enough to travel in parts', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		// `writeFilePartBytes` lowers the split point as well as the part
		// size, so the multi-part route is exercised without allocating a
		// body over the guest's 8 MiB pre-auth ceiling.
		const { transport, refreshHandle } = await staleHandle(port, {
			...SPENT_BUDGET,
			writeFilePartBytes: 1_024,
		})
		const body = Buffer.alloc(8 * 1_024, 0x7a)

		await transport.writeFile('in-parts.bin', body)

		const written = readFileSync(join(workDir, 'in-parts.bin'))
		expect(written.length).toBe(body.length)
		expect(written.equals(body)).toBe(true)
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		// It really took the PARTS route: every request dials its own
		// connection, so one capability probe plus eight parts plus the
		// rename is a count a single-frame write could not produce.
		expect(connections).toBeGreaterThan(5)
		// The retry starts a fresh sequence under a new temp name and finishes
		// it with the atomic rename, so nothing is left behind.
		expect(strayPartFiles()).toEqual([])
	}, 20_000)

	it('rebinds openTcpConnection()', async () => {
		const { port } = await startAgent(REPLACEMENT_UID)
		const upstream = createServer((socket) => {
			socket.once('data', (chunk) => socket.end(Buffer.concat([Buffer.from('reply:'), chunk])))
		})
		await new Promise<void>((resolve, reject) => {
			upstream.once('error', reject)
			upstream.listen(0, '127.0.0.1', resolve)
		})
		try {
			const address = upstream.address() as AddressInfo
			const { transport, refreshHandle } = await staleHandle(port, SPENT_BUDGET)

			const connection = await transport.openTcpConnection({ port: address.port })
			let output = ''
			const dispose = connection.onData((chunk) => {
				output += Buffer.from(chunk).toString('utf8')
			})
			connection.write('hello')
			await expect(connection.closed).resolves.toBeUndefined()

			expect(output).toBe('reply:hello')
			expect(refreshHandle).toHaveBeenCalledTimes(1)
			dispose()
		} finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()))
		}
	})

	it.skipIf(process.platform !== 'linux')(
		'rebinds openTerminal()',
		async () => {
			const { port } = await startAgent(REPLACEMENT_UID)
			const { transport, refreshHandle } = await staleHandle(port, SPENT_BUDGET)

			const terminal = await transport.openTerminal({
				command: '/bin/sh',
				cwd: workDir,
				size: { cols: 80, rows: 24 },
			})
			let output = ''
			const unsubscribe = terminal.onData((chunk) => {
				output += chunk
			})
			terminal.write('echo __ON_THE_NEW_POD__; exit 0\n')
			await vi.waitFor(() => expect(output).toContain('__ON_THE_NEW_POD__'))
			await expect(terminal.exited).resolves.toMatchObject({ exitCode: 0 })
			unsubscribe()

			expect(refreshHandle).toHaveBeenCalledTimes(1)
		},
		20_000,
	)

	it('leaves the original error standing when the pod is UNCHANGED', async () => {
		// The re-read answers with the same uid at an address that WOULD
		// work, so a transport that adopted any refreshed handle would
		// succeed here. A pod that is still there and still refusing
		// connections is the guest's problem, and retrying it would hide it.
		const { port } = await startAgent(POD_UID)
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentHandle> => ({
				kind: 'tcp',
				host: '127.0.0.1',
				port,
				token: POD_UID,
			}),
		)
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: '127.0.0.1', port: await closedPort(), token: POD_UID },
			{ refreshHandle },
		)

		const error = await transport.exec('/bin/true').then(
			() => undefined,
			(err: unknown) => err,
		)

		// The ORIGINAL failure, unrewritten — for `exec()` that is the
		// controller's own bound on the reservation, which is what a dial
		// still inside its retry budget surfaces as.
		expect((error as Error | undefined)?.message).toMatch(/reservation exceeded \d+ms/)
		// One re-read for the call, not one per attempt, and no retry: the
		// live agent was never dialed.
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		expect(connections).toBe(0)
	}, 20_000)

	it('never retries an outcome the controller could not confirm', async () => {
		// A command that was ADMITTED and then lost its connection is the one
		// failure a rebind must not touch: the controller says so in its own
		// words ("do not automatically retry the command"), and it
		// interpolates the underlying failure into its message — so a cancel
		// that cannot be dialed puts the dial's own marker inside a
		// `RemoteCancellationUnknownError`. Classifying on that marker alone
		// would re-run a command that may already be running, against a disk
		// that followed the pod.
		const lost = createServer((socket) => {
			const reader = new __framing.FrameReader()
			socket.on('error', () => {})
			socket.on('data', (chunk: Buffer) => {
				for (const payload of reader.push(chunk)) {
					if (payload.length === 0) continue
					const op = (JSON.parse(payload) as { op?: string }).op
					if (op === 'reserve-execution') {
						socket.write(
							__framing.frame(
								JSON.stringify({
									ok: true,
									protocolVersion: 2,
									executionId: `exec_${randomUUID()}`,
									leaseExpiresAt: Date.now() + 60_000,
								}),
							),
						)
						socket.end()
						continue
					}
					// The command was admitted, and the pod then went away:
					// nothing more is accepted, and this connection dies with
					// the command still running as far as the host knows.
					lost.close()
					socket.destroy()
				}
			})
		})
		await new Promise<void>((resolve) => lost.listen(0, '127.0.0.1', resolve))
		const { port } = lost.address() as AddressInfo
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentHandle> => ({
				kind: 'tcp',
				host: '127.0.0.1',
				port: (listener?.address() as AddressInfo | undefined)?.port ?? port,
				token: REPLACEMENT_UID,
			}),
		)
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: '127.0.0.1', port, token: POD_UID },
			{ ...SPENT_BUDGET, refreshHandle },
		)

		const error = await transport.exec('/bin/sh', ['-c', 'true']).then(
			() => undefined,
			(err: unknown) => err,
		)

		expect((error as Error | undefined)?.name).toBe('RemoteCancellationUnknownError')
		// The dial's marker IS in that message — this case is only worth
		// anything because it is.
		expect((error as Error).message).toContain('could not connect to agent')
		expect(refreshHandle).not.toHaveBeenCalled()
	}, 30_000)
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
