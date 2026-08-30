/**
 * Firecracker `SandboxBackend` end-to-end over the loopback agent.
 *
 * Stubs the orchestrator control plane (`fetch` for `/sandboxes` create
 * + `:delete`) and points the returned vsock handle at a unix-socket
 * loopback running the REAL `agent/agent.cjs`. Proves the full
 * {@link Sandbox} handle the SDK consumes — `exec` / `writeFile` /
 * `readFile` / `listFiles` / `destroy` / `status` — speaks the NDJSON
 * wire over the vsock transport, and that the readiness fence waits on
 * the agent's healthz (not the orchestrator 2xx).
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildFirecrackerBackend, normalizeHandle } from '../index.js'
import { type WireSandboxAgentHandle, __framing } from '../transport.js'
import { localIpcPath } from './fixtures/ipc-path.js'
import {
	CA_CRT,
	CLIENT_CRT,
	CLIENT_KEY,
	type RelayHandle,
	startMtlsRelay,
} from './fixtures/mtls-pki.js'
// The loopback agent under test is the guest-side agent for a Linux microVM:
// it spawns `/bin/sh` to run commands, and that binary does not exist on
// Windows. These cases assert behavior the platform cannot produce, so they
// skip there rather than leaving the suite permanently red for Windows
// contributors. The socket-address fixture IS platform-correct, so the
// transport is still exercised wherever it can be.
const IS_WINDOWS = process.platform === 'win32'

const require_ = createRequire(import.meta.url)

interface AgentModule {
	handleConnection(socket: Socket): void
}

let workDir: string
let sockPath: string
let server: Server | undefined
let relay: RelayHandle | undefined
let agent: AgentModule
const realFetch = globalThis.fetch
let realPath: string | undefined

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'fc-backend-test-'))
	sockPath = localIpcPath(workDir)
	realPath = process.env.PATH
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	process.env.NAMZU_AGENT_CANCEL_GRACE_MS = '50'
	process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = '1000'
	delete require_.cache[require_.resolve('../../../../agent/agent.cjs')]
	agent = require_('../../../../agent/agent.cjs') as AgentModule
})

afterEach(async () => {
	globalThis.fetch = realFetch
	process.env.PATH = realPath
	// biome-ignore lint/performance/noDelete: restore module-level test configuration.
	delete process.env.NAMZU_AGENT_CANCEL_GRACE_MS
	// biome-ignore lint/performance/noDelete: restore module-level test configuration.
	delete process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS
	if (relay) {
		await new Promise<void>((r) => relay?.server.close(() => r()))
		relay = undefined
	}
	if (server) {
		await new Promise<void>((r) => server?.close(() => r()))
		server = undefined
	}
	rmSync(workDir, { recursive: true, force: true })
})

function startAgentServer(connectionHandler: (socket: Socket) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const s = createServer(connectionHandler)
		s.on('error', reject)
		s.listen(sockPath, () => resolve(s))
	})
}

function startAgent(): Promise<Server> {
	return startAgentServer(agent.handleConnection)
}

/**
 * Stub the orchestrator: `POST /sandboxes` returns a handle pointing at
 * the loopback unix socket; `:delete` returns 204. Records calls so the
 * test can assert the create body + destroy round-trip.
 */
function stubOrchestrator(
	handle: WireSandboxAgentHandle,
	deleteStatus = 204,
): {
	calls: Array<{ url: string; method: string; body?: unknown }>
} {
	const calls: Array<{ url: string; method: string; body?: unknown }> = []
	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		calls.push({ url, method, body })
		if (method === 'POST' && url.endsWith('/sandboxes')) {
			return new Response(
				JSON.stringify({
					sandboxId: 'sbx_fc_test',
					agent: handle,
					rootDir: workDir,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (method === 'DELETE' && url.includes(':delete')) {
			return new Response(null, { status: deleteStatus })
		}
		return new Response('unexpected', { status: 500 })
	}) as typeof fetch
	return { calls }
}

describe.skipIf(IS_WINDOWS)('buildFirecrackerBackend (loopback agent)', () => {
	it('creates a Sandbox handle and round-trips exec/write/read/listFiles/destroy', async () => {
		server = await startAgent()
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath })

		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'token-123',
			template: 'golden-rev-7',
			readyTimeoutMs: 5_000,
			readyPollIntervalMs: 50,
		})

		const sandbox = await backend.create({
			workingDirectory: workDir,
			memoryLimitMb: 512,
			maxProcesses: 64,
			timeoutMs: 60_000,
			egress: { kind: 'static', allowedHosts: ['api.example.com'] },
		})

		// Handle shape.
		expect(sandbox.id).toBe('sbx_fc_test')
		expect(sandbox.rootDir).toBe(workDir)
		expect(sandbox.environment).toBe('linux-namespace')
		expect(sandbox.status).toBe('ready')

		// Create body forwarded the resolved knobs + egress allowlist.
		const createCall = calls.find((c) => c.method === 'POST')
		expect(createCall?.body).toMatchObject({
			template: 'golden-rev-7',
			memoryLimitMb: 512,
			maxProcesses: 64,
			timeoutMs: 60_000,
			egressAllowlist: ['api.example.com'],
		})

		// exec over the wire.
		const r = await sandbox.exec('/bin/sh', ['-c', 'echo hello-fc'])
		expect(r.stdout).toContain('hello-fc')
		expect(r.exitCode).toBe(0)

		// writeFile + readFile round-trip.
		await sandbox.writeFile('out/result.txt', 'persisted')
		const read = await sandbox.readFile('out/result.txt')
		expect(read.toString('utf8')).toBe('persisted')

		// listFiles uses the same `find -printf '%p\t%s\n'` wire as
		// docker/aci. On a GNU-find host (the Ubuntu golden rootfs) it
		// enumerates the file we wrote; on a BSD-find host (macOS CI
		// runners) `-printf` is unsupported, find exits non-zero, and the
		// contract maps that to an empty listing — exactly as docker/aci
		// do. Assert the call path returns the SDK shape either way, and
		// the file when GNU find is present.
		const files = await sandbox.listFiles(workDir)
		expect(Array.isArray(files)).toBe(true)
		if (files.length > 0) {
			expect(files.some((f) => f.path.endsWith('out/result.txt'))).toBe(true)
			expect(files.every((f) => Number.isFinite(f.size))).toBe(true)
		}

		// destroy calls the orchestrator :delete and flips status.
		await Promise.all([sandbox.destroy(), sandbox.destroy()])
		expect(sandbox.status).toBe('destroyed')
		expect(calls.filter((c) => c.method === 'DELETE' && c.url.includes(':delete'))).toHaveLength(1)
	})

	it('tears down the microVM when the readiness fence times out (no orphan)', async () => {
		// No agent listening → healthz never succeeds → readiness fence
		// times out → backend must DELETE to avoid orphaning the microVM.
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 300,
			readyPollIntervalMs: 50,
			transport: {
				connectRetryBudgetMs: 100,
				connectTimeoutMs: 80,
				connectRetryIntervalMs: 30,
			},
		})
		await expect(backend.create({ workingDirectory: workDir })).rejects.toThrow(
			/did not become ready/,
		)
		expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
	})

	it('honours public exec cancellation and keeps a confirmed-quiescent microVM reusable', async () => {
		server = await startAgent()
		stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 1_000,
			readyPollIntervalMs: 10,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })
		const caller = new AbortController()
		let observedReady: (() => void) | undefined
		const ready = new Promise<void>((resolve) => {
			observedReady = resolve
		})

		const running = sandbox.exec(
			'/bin/sh',
			['-c', "trap '' TERM; (trap '' TERM; sleep 0.4; printf late > late.txt) & echo ready; wait"],
			{
				signal: caller.signal,
				onOutput: (chunk) => {
					if (chunk.stream === 'stdout' && chunk.data.includes('ready')) observedReady?.()
				},
			},
		)
		await ready
		expect(sandbox.status).toBe('busy')
		caller.abort(new Error('operator cancelled'))

		await expect(running).resolves.toMatchObject({
			signal: 'SIGKILL',
			timedOut: false,
		})
		expect(sandbox.status).toBe('ready')
		await new Promise((resolve) => setTimeout(resolve, 500))
		await expect(sandbox.readFile('late.txt')).rejects.toThrow()
		await expect(sandbox.exec('/bin/sh', ['-c', 'printf reused'])).resolves.toMatchObject({
			stdout: 'reused',
			exitCode: 0,
		})
		await sandbox.destroy()
	})

	it('fences and retires the whole microVM when the guest reports an unknown process outcome', async () => {
		let agentConnections = 0
		server = await startAgentServer((socket) => {
			agentConnections += 1
			const reader = new __framing.FrameReader()
			socket.on('data', (chunk: Buffer) => {
				const payload = reader.push(chunk)[0]
				if (payload === undefined) return
				const request = JSON.parse(payload) as { op?: string }
				if (request.op === 'healthz') {
					socket.end(__framing.frame(JSON.stringify({ ok: true })))
					return
				}
				if (request.op === 'reserve-execution') {
					socket.end(__framing.frame(JSON.stringify({ ok: false, error: 'agent_retiring' })))
					return
				}
				socket.end(__framing.frame(JSON.stringify({ ok: false, error: 'unexpected' })))
			})
		})
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath }, 410)
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 1_000,
			readyPollIntervalMs: 10,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })

		try {
			await sandbox.exec('/bin/true')
			expect.unreachable('a self-fenced guest must retire its microVM')
		} catch (error) {
			expect(error).toMatchObject({ retirement: { accepted: true } })
			expect((error as Error).message).toMatch(/must be retired/)
		}
		expect(sandbox.status).toBe('destroyed')
		expect(agentConnections).toBe(2)
		expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
		await expect(sandbox.readFile('anything')).rejects.toThrow(/no new guest operation/)
	})

	it('retires after an admitted data stream is lost and cancellation cannot be confirmed', async () => {
		let executeCalls = 0
		let cancelCalls = 0
		server = await startAgentServer((socket) => {
			const reader = new __framing.FrameReader()
			socket.on('data', (chunk: Buffer) => {
				const payload = reader.push(chunk)[0]
				if (payload === undefined) return
				const request = JSON.parse(payload) as { op?: string }
				if (request.op === 'healthz') {
					socket.end(__framing.frame(JSON.stringify({ ok: true })))
					return
				}
				if (request.op === 'reserve-execution') {
					socket.end(
						__framing.frame(
							JSON.stringify({
								ok: true,
								protocolVersion: 2,
								executionId: 'exec_00000000-0000-4000-8000-000000000001',
								leaseExpiresAt: Date.now() + 30_000,
							}),
						),
					)
					return
				}
				if (request.op === 'execute') {
					executeCalls += 1
					socket.destroy()
					return
				}
				if (request.op === 'cancel-execution') {
					cancelCalls += 1
					socket.end(
						__framing.frame(JSON.stringify({ ok: false, error: 'cancellation_unconfirmed' })),
					)
				}
			})
		})
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 1_000,
			readyPollIntervalMs: 10,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })

		try {
			await sandbox.exec('/bin/true')
			expect.unreachable('an admitted command with unknown termination must retire the VM')
		} catch (error) {
			expect(error).toMatchObject({ retirement: { accepted: true } })
			expect((error as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		}
		expect(executeCalls).toBe(1)
		expect(cancelCalls).toBeGreaterThan(1)
		expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
		expect(sandbox.status).toBe('destroyed')
		await expect(sandbox.exec('/bin/true')).rejects.toThrow(/no new guest operation/)
	}, 12_000)

	it('does not let a held failure DELETE keep create pending forever', async () => {
		let deleteCalls = 0
		let deleteSignal: AbortSignal | undefined
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (method === 'POST' && url.endsWith('/sandboxes')) {
				return new Response(
					JSON.stringify({
						sandboxId: 'sbx_fc_held_delete',
						agent: { kind: 'unix', path: sockPath },
						rootDir: workDir,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (method === 'DELETE') {
				deleteCalls += 1
				deleteSignal = init?.signal ?? undefined
				return await new Promise<Response>((_resolve, reject) => {
					deleteSignal?.addEventListener('abort', () => reject(deleteSignal?.reason), {
						once: true,
					})
				})
			}
			return new Response('unexpected', { status: 500 })
		}) as typeof fetch

		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 20,
			readyPollIntervalMs: 5,
			transport: {
				connectRetryBudgetMs: 10,
				connectTimeoutMs: 5,
				connectRetryIntervalMs: 2,
			},
		})
		const startedAt = performance.now()

		await expect(backend.create({ workingDirectory: workDir })).rejects.toThrow(
			/did not become ready/,
		)
		expect(deleteCalls).toBe(1)
		expect(deleteSignal?.aborted).toBe(true)
		// Health timeout + the package-owned one-second cleanup grace, with
		// ample scheduler tolerance. The old code never settled at all.
		expect(performance.now() - startedAt).toBeLessThan(1_750)
	})

	it('interrupts a held create transport and reports the unidentified remote outcome', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let createSignal: AbortSignal | undefined
		let deleteCalls = 0
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				deleteCalls += 1
				return new Response(null, { status: 204 })
			}
			createSignal = init?.signal ?? undefined
			markStarted()
			return await new Promise<Response>((_resolve, reject) => {
				const safety = setTimeout(() => reject(new Error('test safety release')), 100)
				createSignal?.addEventListener(
					'abort',
					() => {
						clearTimeout(safety)
						reject(createSignal?.reason)
					},
					{ once: true },
				)
			})
		}) as typeof fetch
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
		})
		const caller = new AbortController()
		const pending = backend.create({
			workingDirectory: workDir,
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped allocation')
		caller.abort(reason)

		await expect(pending).rejects.toThrow(/allocation outcome is unresolved/)
		expect(createSignal).toBe(caller.signal)
		expect(createSignal?.reason).toBe(reason)
		// No server-minted id arrived, so manufacturing a DELETE target would be
		// a lie. The actionable error names the fleet reaper that owns this case.
		expect(deleteCalls).toBe(0)
	})

	it('validates readiness before requesting an orchestrator token', () => {
		const getToken = vi.fn(async () => 'tok')
		expect(() =>
			buildFirecrackerBackend({
				orchestratorEndpoint: 'https://orchestrator.test/',
				getToken,
				readyPollIntervalMs: Number.POSITIVE_INFINITY,
			}),
		).toThrow(/firecracker\.readyPollIntervalMs/)
		expect(getToken).not.toHaveBeenCalled()
	})

	it('parses listFiles output into {path,size} entries (GNU-find-shaped wire)', async () => {
		// Make `find` deterministic across host platforms: shim a `find`
		// on PATH that emits the GNU `-printf '%p\t%s\n'` wire the Ubuntu
		// golden rootfs produces, so the backend's tab-split parser is
		// proven without depending on the host having GNU findutils.
		const binDir = mkdtempSync(join(tmpdir(), 'fc-bin-'))
		const findShim = join(binDir, 'find')
		writeFileSync(
			findShim,
			[
				'#!/bin/sh',
				`printf '%s\\t%s\\n' '${workDir}/out/result.txt' 9`,
				`printf '%s\\t%s\\n' '${workDir}/out/other.bin' 42`,
			].join('\n'),
			{ mode: 0o755 },
		)
		chmodSync(findShim, 0o755)
		process.env.PATH = `${binDir}:${process.env.PATH}`

		server = await startAgent()
		stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			readyTimeoutMs: 3_000,
			readyPollIntervalMs: 50,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })
		const files = await sandbox.listFiles(workDir)
		expect(files).toEqual([
			{ path: `${workDir}/out/result.txt`, size: 9 },
			{ path: `${workDir}/out/other.bin`, size: 42 },
		])
		await sandbox.destroy()
		rmSync(binDir, { recursive: true, force: true })
	})

	it('fills the contract vsock port when the orchestrator omits it', async () => {
		// A vsock handle whose port is 0 should be normalized to the
		// configured agentVsockPort. We can't bind a real AF_VSOCK here, so
		// assert the normalization path via a unix handle is unaffected and
		// that a portless vsock handle does not crash create's pre-dial.
		// (Full vsock dial is the live increment.)
		server = await startAgent()
		stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			agentVsockPort: 1024,
			readyTimeoutMs: 3_000,
			readyPollIntervalMs: 50,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })
		expect(sandbox.status).toBe('ready')
		await sandbox.destroy()
	})

	it('carries agentSnapshot in the create body when the backend config sets it', async () => {
		// OPEN-2 — the per-agent snapshot ref is a first-class, provider-agnostic
		// field on the create contract (sibling to `template`). When set it must
		// reach the orchestrator POST body verbatim.
		server = await startAgent()
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			template: 'golden-rev-7',
			agentSnapshot: { orgId: 'org1', agentId: 'agent9', version: '3' },
			readyTimeoutMs: 3_000,
			readyPollIntervalMs: 50,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })
		const createCall = calls.find((c) => c.method === 'POST')
		expect(createCall?.body).toMatchObject({
			template: 'golden-rev-7',
			agentSnapshot: { orgId: 'org1', agentId: 'agent9', version: '3' },
		})
		await sandbox.destroy()
	})

	it('OMITS agentSnapshot from the create body when absent (byte-identical generic path)', async () => {
		// DORMANT contract: absent ⇒ the POST body must NOT carry an
		// `agentSnapshot` key at all (a JSON `undefined` would not serialise, but
		// the conditional spread must drop the key entirely so the body is
		// byte-identical to the pre-field generic create).
		server = await startAgent()
		const { calls } = stubOrchestrator({ kind: 'unix', path: sockPath })
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: 'https://orchestrator.test/',
			getToken: async () => 'tok',
			template: 'golden-rev-7',
			readyTimeoutMs: 3_000,
			readyPollIntervalMs: 50,
		})
		const sandbox = await backend.create({ workingDirectory: workDir })
		const createCall = calls.find((c) => c.method === 'POST')
		expect(createCall?.body).toEqual({ template: 'golden-rev-7' })
		expect(Object.prototype.hasOwnProperty.call(createCall?.body ?? {}, 'agentSnapshot')).toBe(
			false,
		)
		await sandbox.destroy()
	})
})

// ---------------------------------------------------------------------------
// Cert-injection seam (ses_051 P4 Track C) — the orchestrator returns a WIRE
// `mtls` handle (host/port/sandboxId, NO certs); the consumer injects the
// client CA/cert/key via `config.mtls`, which `normalizeHandle` MERGES onto
// the handle before the transport dials the relay. Certs NEVER transit the
// control plane.
// ---------------------------------------------------------------------------

describe('normalizeHandle (mtls cert injection)', () => {
	const WIRE_MTLS = {
		kind: 'mtls',
		host: '10.60.1.7',
		port: 8443,
		sandboxId: 'sb-net',
	} as const satisfies WireSandboxAgentHandle

	it('merges the injected cert material onto a wire mtls handle', () => {
		const handle = normalizeHandle(WIRE_MTLS, 1024, {
			ca: CA_CRT,
			cert: CLIENT_CRT,
			key: CLIENT_KEY,
			servername: 'sandbox.fc.internal',
		})
		expect(handle).toEqual({
			kind: 'mtls',
			host: '10.60.1.7',
			port: 8443,
			sandboxId: 'sb-net',
			tls: {
				ca: CA_CRT,
				cert: CLIENT_CRT,
				key: CLIENT_KEY,
				servername: 'sandbox.fc.internal',
			},
		})
	})

	it('throws when an mtls handle arrives with NO injected cert material', () => {
		// A network-mode backend that cannot present a client cert would be
		// rejected by the relay — fail loud at handle-normalization instead.
		expect(() => normalizeHandle(WIRE_MTLS, 1024, undefined)).toThrow(
			/no client cert material was injected/,
		)
	})

	it('leaves vsock + unix handles untouched (cert material is ignored)', () => {
		expect(normalizeHandle({ kind: 'unix', path: '/tmp/a.sock' }, 1024, undefined)).toEqual({
			kind: 'unix',
			path: '/tmp/a.sock',
		})
		// A vsock handle with a 0 port still normalizes to the contract port.
		expect(
			normalizeHandle({ kind: 'vsock', udsPath: '/v.sock', port: 0 }, 1024, {
				ca: CA_CRT,
				cert: CLIENT_CRT,
				key: CLIENT_KEY,
			}),
		).toEqual({ kind: 'vsock', udsPath: '/v.sock', port: 1024 })
	})
})

describe.skipIf(IS_WINDOWS)(
	'buildFirecrackerBackend (network mode over a loopback mTLS relay)',
	() => {
		it('injects the client cert + round-trips exec/file-IO through the relay', async () => {
			// The agent on a unix socket; a loopback mTLS relay in front of it.
			server = await startAgent()
			relay = await startMtlsRelay(sockPath)
			// The orchestrator returns a WIRE mtls handle (NO cert material) whose
			// host:port point at the relay; the relay resolves the sandboxId.
			const { calls } = stubOrchestrator({
				kind: 'mtls',
				host: '127.0.0.1',
				port: relay.port,
				sandboxId: 'sb-net',
			})

			const backend = buildFirecrackerBackend({
				orchestratorEndpoint: 'https://orchestrator.test/',
				getToken: async () => 'tok',
				readyTimeoutMs: 5_000,
				readyPollIntervalMs: 50,
				// The CONSUMER-injected client material — never returned by the
				// orchestrator. Merged onto the handle's `tls` block.
				mtls: {
					ca: CA_CRT,
					cert: CLIENT_CRT,
					key: CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
			})

			const sandbox = await backend.create({ workingDirectory: workDir })
			expect(sandbox.status).toBe('ready')

			// The dialer wrote the `SANDBOX <id>` routing preamble (the relay's key).
			expect(await relay.preamble()).toBe('sb-net')

			// Full exec + file-IO round-trip over the mTLS tunnel.
			const r = await sandbox.exec('/bin/sh', ['-c', 'echo hello-mtls'])
			expect(r.stdout).toContain('hello-mtls')
			await sandbox.writeFile('out/r.txt', 'via-relay')
			expect((await sandbox.readFile('out/r.txt')).toString('utf8')).toBe('via-relay')

			await sandbox.destroy()
			expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
		})

		it('rejects a create when the orchestrator returns mtls but no cert material is injected', async () => {
			server = await startAgent()
			relay = await startMtlsRelay(sockPath)
			stubOrchestrator({
				kind: 'mtls',
				host: '127.0.0.1',
				port: relay.port,
				sandboxId: 'sb-net',
			})
			const backend = buildFirecrackerBackend({
				orchestratorEndpoint: 'https://orchestrator.test/',
				getToken: async () => 'tok',
				readyTimeoutMs: 2_000,
				readyPollIntervalMs: 50,
				// No `mtls` material → normalizeHandle must throw at create time.
			})
			await expect(backend.create({ workingDirectory: workDir })).rejects.toThrow(
				/no client cert material was injected/,
			)
		})
	},
)
