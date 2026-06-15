/**
 * Loopback transport round-trip tests for the Firecracker vsock path.
 *
 * These prove the NEW transport (host dialer ↔ in-VM agent) over a
 * **unix-socket stand-in** — the faithful local peer for AF_VSOCK,
 * because the production vsock path also terminates on a host
 * unix socket (see `transport.ts` docblock). The peer is the REAL
 * `agent/agent.cjs` connection handler (its spawn/jail + NDJSON shapes
 * verbatim), driven in-process over a temp unix socket; the client is
 * the REAL {@link VsockAgentTransport}. So one test exercises:
 *   - exec → streamed stdout/stderr/result NDJSON, accumulated;
 *   - writeFile / readFile → base64 round-trip through the jail;
 *   - a simulated resume (server torn down + re-listened) survived by
 *     the dialer's connect-retry budget — the FC #4713 invariant.
 *
 * No docker, no Azure, no AF_VSOCK kernel support required: pure
 * loopback, safe in CI.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VsockAgentTransport } from '../transport.js'

// The agent is a CommonJS module that reads NAMZU_SANDBOX_WORKSPACE at
// require-time. Set the env, then require it through createRequire so
// each test file gets a fresh module bound to its own workspace dir.
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

interface AgentModule {
	handleConnection(socket: Socket): void
}

let workDir: string
let sockPath: string
let server: Server | undefined
let agent: AgentModule

function startAgentServer(connHandler: (s: Socket) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const s = createServer(connHandler)
		s.on('error', reject)
		s.listen(sockPath, () => resolve(s))
	})
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'fc-agent-test-'))
	sockPath = join(workDir, 'agent.sock')
	// Bind the agent's workspace jail to the temp dir BEFORE requiring it.
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	// The agent's root-normalization filters env on PRESENCE; `= undefined`
	// sets the literal string "undefined" and would widen READ/WRITE_ROOTS, so
	// these must be true deletes.
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	delete process.env.NAMZU_SANDBOX_READ_ROOTS
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	delete process.env.NAMZU_SANDBOX_WRITE_ROOTS
	// Fresh module each test so WORKSPACE_ROOT is rebound.
	delete require_.cache[require_.resolve('../../../../agent/agent.cjs')]
	agent = require_('../../../../agent/agent.cjs') as AgentModule
})

afterEach(async () => {
	if (server) {
		await new Promise<void>((r) => server?.close(() => r()))
		server = undefined
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe('VsockAgentTransport over a unix-socket loopback agent', () => {
	it('streams stdout/stderr/result NDJSON from an exec', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		const r = await transport.execute({
			command: '/bin/sh',
			args: ['-c', 'echo out-line; echo err-line 1>&2; exit 3'],
		})
		expect(r.stdout).toContain('out-line')
		expect(r.stderr).toContain('err-line')
		expect(r.exitCode).toBe(3)
		expect(r.timedOut).toBe(false)
		expect(r.durationMs).toBeGreaterThanOrEqual(0)
	})

	it('streams a large multi-chunk stdout intact (delta accumulation)', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		// 200 lines so the agent emits multiple stdout_delta frames the
		// FrameReader must reassemble across socket chunks.
		const r = await transport.execute({
			command: '/bin/sh',
			args: ['-c', 'for i in $(seq 1 200); do echo "line-$i"; done'],
		})
		expect(r.exitCode).toBe(0)
		const lines = r.stdout.trim().split('\n')
		expect(lines.length).toBe(200)
		expect(lines[0]).toBe('line-1')
		expect(lines[199]).toBe('line-200')
	})

	it('round-trips writeFile/readFile as base64 through the workspace jail', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		// Binary content (non-UTF8 bytes) proves base64 fidelity, not
		// just text.
		const payload = Buffer.from([0x00, 0xff, 0x10, 0x42, 0x00, 0x99, 0xfe])
		await transport.writeFile('sub/dir/blob.bin', payload)
		const read = await transport.readFile('sub/dir/blob.bin')
		expect(read.equals(payload)).toBe(true)
	})

	it('rejects a path that escapes the workspace jail', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		await expect(transport.readFile('../../../../etc/passwd')).rejects.toThrow(/escapes/)
	})

	it('healthz returns true against a live agent', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		expect(await transport.healthz()).toBe(true)
	})

	it('surfaces an exec error event as a thrown error', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		// Empty command name → agent emits { type: 'error' }.
		await expect(transport.execute({ command: '' })).rejects.toThrow()
	})

	it('survives a simulated resume: server torn down then re-listened, dialer reconnects', async () => {
		// 1. Agent is up; one exec succeeds.
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport(
			{ kind: 'unix', path: sockPath },
			// Tight retry budget so the test is fast but still proves retry.
			{ connectRetryBudgetMs: 5_000, connectRetryIntervalMs: 50, connectTimeoutMs: 1_000 },
		)
		const first = await transport.execute({ command: '/bin/sh', args: ['-c', 'echo before'] })
		expect(first.stdout).toContain('before')

		// 2. Simulate a resume: the FC vsock driver closes all connections
		//    and the listener is gone until the agent re-LISTENs. Tear the
		//    server down entirely.
		await new Promise<void>((r) => server?.close(() => r()))
		server = undefined

		// 3. Kick off an exec WHILE the agent is still down. The dialer's
		//    connect-retry budget must hold (ECONNREFUSED) until the agent
		//    re-listens — this is the FC #4713 / TRANSPORT_RESET-not-
		//    delivered mitigation: the host re-dials rather than hanging.
		const pending = transport.execute({ command: '/bin/sh', args: ['-c', 'echo after'] })

		// 4. After a beat, the agent re-establishes its listen on the SAME
		//    address (the resume re-listen invariant).
		await new Promise((r) => setTimeout(r, 300))
		server = await startAgentServer(agent.handleConnection)

		const after = await pending
		expect(after.stdout).toContain('after')
		expect(after.exitCode).toBe(0)
	})

	it('connect-retry budget gives up with a clear error when the agent never returns', async () => {
		// No server started at all. The dialer should exhaust its budget
		// and throw a descriptive error rather than hang forever.
		const transport = new VsockAgentTransport(
			{ kind: 'unix', path: sockPath },
			{ connectRetryBudgetMs: 400, connectRetryIntervalMs: 50, connectTimeoutMs: 200 },
		)
		await expect(transport.healthz()).resolves.toBe(false)
		await expect(transport.readFile('x')).rejects.toThrow(/could not connect to agent/)
	})
})
