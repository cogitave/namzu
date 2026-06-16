/**
 * Control-plane mTLS dial for the Firecracker backend (additive
 * `config.controlPlaneMtls`).
 *
 * A loopback `https.createServer` with `requestCert + rejectUnauthorized`
 * (pinned to the test CA) stands in for the orchestrator over the public hop.
 * It serves the real `POST /sandboxes` + `:delete` routes; the create response
 * points the agent handle at a unix-socket loopback running the REAL
 * `agent/agent.cjs`, so the FULL create flow (control-plane POST over mTLS →
 * vsock readiness fence → exec) runs end to end.
 *
 * Proves:
 *  - with `controlPlaneMtls` injected, the create POST succeeds over mTLS and
 *    the sandbox round-trips an exec.
 *  - WITHOUT the client cert (no `controlPlaneMtls`, so the backend uses plain
 *    `fetch` against the https listener), create is rejected at the TLS layer.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import {
	type Server as HttpsServer,
	createServer as createHttpsServer,
	request as httpsRequest,
} from 'node:https'
import { createRequire } from 'node:module'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildFirecrackerBackend } from '../index.js'
import {
	CA_CRT,
	CLIENT_CRT,
	CLIENT_KEY,
	ROGUE_CLIENT_CRT,
	ROGUE_CLIENT_KEY,
	SERVER_CRT,
	SERVER_KEY,
} from './fixtures/mtls-pki.js'

const require_ = createRequire(import.meta.url)

interface AgentModule {
	handleConnection(socket: Socket): void
}

let workDir: string
let sockPath: string
let agentServer: Server | undefined
let orchestrator: HttpsServer | undefined
let agent: AgentModule

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'fc-cp-mtls-'))
	sockPath = join(workDir, 'agent.sock')
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	delete require_.cache[require_.resolve('../../../../agent/agent.cjs')]
	agent = require_('../../../../agent/agent.cjs') as AgentModule
})

afterEach(async () => {
	if (orchestrator) {
		await new Promise<void>((r) => orchestrator?.close(() => r()))
		orchestrator = undefined
	}
	if (agentServer) {
		await new Promise<void>((r) => agentServer?.close(() => r()))
		agentServer = undefined
	}
	rmSync(workDir, { recursive: true, force: true })
})

function startAgent(): Promise<Server> {
	return new Promise((resolve, reject) => {
		const s = createServer(agent.handleConnection)
		s.on('error', reject)
		s.listen(sockPath, () => resolve(s))
	})
}

/**
 * A loopback mTLS orchestrator. Requires + verifies a client cert chaining to
 * the test CA, then serves the control-plane routes: `POST /sandboxes` returns
 * a unix agent handle, `:delete` returns 204. Records calls so the test can
 * assert the create round-trip.
 */
function startMtlsOrchestrator(handlePath: string): Promise<{
	server: HttpsServer
	port: number
	calls: Array<{ method: string; url: string }>
}> {
	const calls: Array<{ method: string; url: string }> = []
	return new Promise((resolve, reject) => {
		const server = createHttpsServer(
			{
				cert: SERVER_CRT,
				key: SERVER_KEY,
				ca: CA_CRT,
				requestCert: true,
				rejectUnauthorized: true,
				minVersion: 'TLSv1.3',
			},
			(req, res) => {
				const method = req.method ?? 'GET'
				const url = req.url ?? '/'
				calls.push({ method, url })
				// Drain the body, then respond per route.
				req.on('data', () => {})
				req.on('end', () => {
					if (method === 'POST' && url.endsWith('/sandboxes')) {
						res.statusCode = 200
						res.setHeader('content-type', 'application/json')
						res.end(
							JSON.stringify({
								sandboxId: 'sbx_cp_mtls',
								agent: { kind: 'unix', path: handlePath },
								rootDir: workDir,
							}),
						)
						return
					}
					if (method === 'DELETE' && url.includes(':delete')) {
						res.statusCode = 204
						res.end()
						return
					}
					res.statusCode = 500
					res.end('unexpected')
				})
			},
		)
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr === null || typeof addr === 'string') {
				reject(new Error('orchestrator: no TCP port'))
				return
			}
			resolve({ server, port: addr.port, calls })
		})
	})
}

describe('buildFirecrackerBackend (control-plane mTLS dial)', () => {
	it('create POST succeeds over mTLS and round-trips an exec', async () => {
		agentServer = await startAgent()
		const orch = await startMtlsOrchestrator(sockPath)
		orchestrator = orch.server

		const backend = buildFirecrackerBackend({
			// An https:// endpoint over the (loopback stand-in for the) public hop.
			orchestratorEndpoint: `https://127.0.0.1:${orch.port}/`,
			getToken: async () => 'tok',
			readyTimeoutMs: 5_000,
			readyPollIntervalMs: 50,
			// CONTROL-plane client material — injected by the consumer, never
			// shipped by the orchestrator. Drives the node:https mTLS dial.
			controlPlaneMtls: {
				ca: CA_CRT,
				cert: CLIENT_CRT,
				key: CLIENT_KEY,
				servername: 'sandbox.fc.internal',
			},
		})

		const sandbox = await backend.create({ workingDirectory: workDir })
		expect(sandbox.id).toBe('sbx_cp_mtls')
		expect(sandbox.status).toBe('ready')

		// The control-plane POST reached the mTLS orchestrator.
		expect(orch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/sandboxes'))).toBe(true)

		// Exec over the vsock tunnel (the data plane), proving the whole flow.
		const r = await sandbox.exec('/bin/sh', ['-c', 'echo hello-cp-mtls'])
		expect(r.stdout).toContain('hello-cp-mtls')

		// destroy DELETE also rides the mTLS control plane.
		await sandbox.destroy()
		expect(orch.calls.some((c) => c.method === 'DELETE' && c.url.includes(':delete'))).toBe(true)
	})

	it('the backend without controlPlaneMtls cannot reach the mTLS orchestrator (plain fetch fails the handshake)', async () => {
		agentServer = await startAgent()
		const orch = await startMtlsOrchestrator(sockPath)
		orchestrator = orch.server

		// No `controlPlaneMtls` → the backend uses plain `fetch`, which neither
		// presents a client cert nor trusts the test CA, so the TLS handshake
		// fails and create rejects BEFORE any route runs.
		const backend = buildFirecrackerBackend({
			orchestratorEndpoint: `https://127.0.0.1:${orch.port}/`,
			getToken: async () => 'tok',
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 50,
		})

		await expect(backend.create({ workingDirectory: workDir })).rejects.toThrow(
			/failed to create microVM sandbox/,
		)
		expect(orch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/sandboxes'))).toBe(false)
	})

	it("the orchestrator's requestCert rejects a client presenting NO cert (server-side proof)", async () => {
		// Isolate the SERVER's requestCert+rejectUnauthorized from any client-side
		// CA distrust: dial directly with node:https TRUSTING the server CA but
		// presenting NO client cert. The handshake must be rejected by the server.
		const orch = await startMtlsOrchestrator(sockPath)
		orchestrator = orch.server
		const err = await new Promise<Error | undefined>((resolve) => {
			const req = httpsRequest(
				{
					host: '127.0.0.1',
					port: orch.port,
					method: 'POST',
					path: '/sandboxes',
					ca: CA_CRT,
					servername: 'sandbox.fc.internal',
				},
				() => resolve(undefined),
			)
			req.on('error', (e: Error) => resolve(e))
			req.end()
		})
		expect(err).toBeInstanceOf(Error)
		expect(orch.calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it("the orchestrator's requestCert rejects a client cert from a DIFFERENT CA", async () => {
		const orch = await startMtlsOrchestrator(sockPath)
		orchestrator = orch.server
		const err = await new Promise<Error | undefined>((resolve) => {
			const req = httpsRequest(
				{
					host: '127.0.0.1',
					port: orch.port,
					method: 'POST',
					path: '/sandboxes',
					ca: CA_CRT,
					cert: ROGUE_CLIENT_CRT,
					key: ROGUE_CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
				() => resolve(undefined),
			)
			req.on('error', (e: Error) => resolve(e))
			req.end()
		})
		expect(err).toBeInstanceOf(Error)
		expect(orch.calls.some((c) => c.method === 'POST')).toBe(false)
	})
})
