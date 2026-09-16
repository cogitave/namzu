/**
 * The shared {@link Sandbox} contract, run against the kubernetes backend
 * over a real `agent/agent.cjs` on a loopback TCP socket.
 *
 * This is one of exactly two backends `sandbox-conformance.ts` runs
 * against in this repository — see `firecracker/__tests__/conformance.test.ts`
 * for the other — and running it against both is the whole point: a suite
 * that only ever exercises the backend it was written next to is bespoke
 * tests wearing a contract's name.
 *
 * Every case builds its own agent process, its own fake control-plane HTTP
 * server and its own `Sandbox` — the same fixtures `sandbox-surface.test.ts`
 * assembles for its bespoke cases, generalized here into one `makeSandbox`
 * the shared suite calls once per case.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sandbox } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { defineSandboxConformance } from '../../../testing/sandbox-conformance.js'
import { KubernetesAlreadyGoneError, createKubernetesClient } from '../k8s-client.js'
import { claimPath } from '../objects.js'
import { buildKubernetesSandbox } from '../sandbox.js'
import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { type FakeApiServer, startFakeApiServer } from './fixtures/fake-api-server.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
const NAMESPACE = 'namzu-sandboxes'

interface AgentModule {
	startListening(): Promise<Server>
}

/**
 * Build one fresh kubernetes-backed `Sandbox`: a real agent process on a
 * fresh loopback TCP port, a fake HTTP control plane behind `destroy()`,
 * and a fresh temp working directory. Env vars the agent reads at
 * `require()` time are saved and restored per call, exactly as
 * `sandbox-surface.test.ts` does for its own bespoke cases.
 */
async function makeSandbox(): Promise<{ sandbox: Sandbox; dispose(): Promise<void> }> {
	const saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	const savedPath = process.env.PATH
	for (const key of AGENT_ENV_KEYS) delete process.env[key]

	const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-conformance-')))
	const podUid = randomUUID()
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = podUid
	// Shortened so the abort case spends milliseconds proving the kill
	// rather than the production TERM->KILL escalation window — the same
	// knobs `sandbox-surface.test.ts` and `backend.test.ts` set for the
	// same reason.
	process.env.NAMZU_AGENT_CANCEL_GRACE_MS = '50'
	process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = '1000'

	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	const listener = await agent.startListening()
	const port = (listener.address() as AddressInfo).port

	const server: FakeApiServer = await startFakeApiServer((req) => {
		if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
		if (req.method === 'PATCH') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})

	const client = createKubernetesClient({
		server: server.url,
		namespace: NAMESPACE,
		getToken: async () => 'sa-token',
	})
	const suffix = randomUUID().slice(0, 8)
	const claimName = `namzu-task-conformance-${suffix}`
	const sandboxName = `namzu-conformance-sandbox-${suffix}`
	const ownedPath = claimPath(NAMESPACE, claimName)

	const sandbox = buildKubernetesSandbox({
		name: sandboxName,
		rootDir: workDir,
		transport: new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: podUid,
		}),
		release: async (signal) => {
			try {
				await client.request('DELETE', ownedPath, undefined, signal)
			} catch (error) {
				if (!(error instanceof KubernetesAlreadyGoneError)) throw error
			}
		},
		renew: async (shutdownTime, signal) => {
			await client.request('PATCH', ownedPath, { spec: { lifecycle: { shutdownTime } } }, signal)
		},
		// An hour: no renewal tick should fire inside a single conformance
		// case. `lease-renewal.test.ts` owns the renewal behaviour itself.
		ttlSeconds: 3_600,
	})

	return {
		sandbox,
		async dispose() {
			await new Promise<void>((resolve) => listener.close(() => resolve()))
			await server.close()
			for (const key of AGENT_ENV_KEYS) delete process.env[key]
			for (const [key, value] of Object.entries(saved)) {
				if (value !== undefined) process.env[key] = value
			}
			if (savedPath !== undefined) process.env.PATH = savedPath
			rmSync(workDir, { recursive: true, force: true })
		},
	}
}

describe.skipIf(IS_WINDOWS)('kubernetes backend', () => {
	defineSandboxConformance({
		describe,
		it,
		expect,
		label: 'kubernetes backend',
		makeSandbox,
		// This fixture runs `agent/agent.cjs` straight out of this
		// repository, so the guest under test IS the one that implements
		// ranged and streamed reads.
		supportsRangedAndStreamedReads: true,
	})
})
