/**
 * The shared {@link Sandbox} contract, run against the Firecracker backend
 * over its existing loopback fixture — the real `agent/agent.cjs` on a
 * unix-domain socket, with `globalThis.fetch` stubbed for the orchestrator.
 *
 * Paired with `backends/kubernetes/__tests__/conformance.test.ts`, which
 * runs the identical suite from `testing/sandbox-conformance.ts` against a
 * different backend and a different transport (TCP, not unix-domain).
 * Passing against both is what makes it a contract suite rather than one
 * backend's tests under a new name.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Server, Socket } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sandbox } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { defineSandboxConformance } from '../../../testing/sandbox-conformance.js'
import { buildFirecrackerBackend } from '../index.js'
import { localIpcPath } from './fixtures/ipc-path.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

interface AgentModule {
	handleConnection(socket: Socket): void
}

/**
 * Build one fresh Firecracker-backed `Sandbox`: a real agent process on a
 * fresh unix-domain socket, `globalThis.fetch` stubbed to hand back that
 * socket as the orchestrator's create response, and a fresh temp working
 * directory. Mirrors `backend.test.ts`'s own fixtures, generalized into
 * the one `makeSandbox` the shared suite calls once per case.
 */
async function makeSandbox(): Promise<{ sandbox: Sandbox; dispose(): Promise<void> }> {
	const savedPath = process.env.PATH
	const savedWorkspace = process.env.NAMZU_SANDBOX_WORKSPACE
	const savedGrace = process.env.NAMZU_AGENT_CANCEL_GRACE_MS
	const savedConfirm = process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS
	const realFetch = globalThis.fetch

	const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'fc-conformance-')))
	const sockPath = localIpcPath(workDir)
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	// Shortened for the same reason `backend.test.ts` shortens it: the
	// abort case proves the kill in milliseconds, not the production
	// TERM->KILL escalation window.
	process.env.NAMZU_AGENT_CANCEL_GRACE_MS = '50'
	process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = '1000'

	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	const server: Server = createServer(agent.handleConnection)
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(sockPath, () => resolve())
	})

	const sandboxId = `fc-conformance-${randomUUID()}`
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		if (method === 'POST' && url.endsWith('/sandboxes')) {
			return new Response(
				JSON.stringify({ sandboxId, agent: { kind: 'unix', path: sockPath }, rootDir: workDir }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (method === 'DELETE' && url.includes(':delete')) {
			return new Response(null, { status: 204 })
		}
		return new Response('unexpected', { status: 500 })
	}) as typeof fetch

	const backend = buildFirecrackerBackend({
		orchestratorEndpoint: 'https://orchestrator.test/',
		getToken: async () => 'tok',
		readyTimeoutMs: 3_000,
		readyPollIntervalMs: 20,
	})
	const sandbox = await backend.create({ workingDirectory: workDir })

	return {
		sandbox,
		async dispose() {
			globalThis.fetch = realFetch
			await new Promise<void>((resolve) => server.close(() => resolve()))
			if (savedWorkspace !== undefined) process.env.NAMZU_SANDBOX_WORKSPACE = savedWorkspace
			// biome-ignore lint/performance/noDelete: restore module-level test configuration.
			else delete process.env.NAMZU_SANDBOX_WORKSPACE
			if (savedGrace !== undefined) process.env.NAMZU_AGENT_CANCEL_GRACE_MS = savedGrace
			// biome-ignore lint/performance/noDelete: restore module-level test configuration.
			else delete process.env.NAMZU_AGENT_CANCEL_GRACE_MS
			if (savedConfirm !== undefined)
				process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = savedConfirm
			// biome-ignore lint/performance/noDelete: restore module-level test configuration.
			else delete process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS
			if (savedPath !== undefined) process.env.PATH = savedPath
			rmSync(workDir, { recursive: true, force: true })
		},
	}
}

describe.skipIf(IS_WINDOWS)('firecracker backend', () => {
	defineSandboxConformance({
		describe,
		it,
		expect,
		label: 'firecracker backend',
		makeSandbox,
		// True HERE and not in general: this fixture requires
		// `agent/agent.cjs` from this repository, so it is by construction a
		// guest that has the capability. A real Firecracker deployment runs
		// whatever agent its golden rootfs image baked in, and nothing in
		// this repository builds that image — which is exactly why these
		// cases are an opt-in flag rather than a bump of
		// `SANDBOX_CONTRACT_VERSION`.
		supportsRangedAndStreamedReads: true,
	})
})
