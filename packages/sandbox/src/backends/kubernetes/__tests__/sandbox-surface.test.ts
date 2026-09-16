/**
 * The whole Sandbox surface, against the REAL guest agent
 * (`agent/agent.cjs`) on a loopback TCP socket in preset-token mode, with a
 * real HTTP API server behind `destroy()`.
 *
 * Nothing here is stubbed on either side of the boundary that matters: the
 * exec streams come off a real spawned process through the real framing, the
 * terminal is a real PTY, `openTcpConnection` really forwards bytes, and the
 * DELETE really goes over HTTP. The one thing these cases do NOT go through
 * is `create()`, and deliberately: `create()` gates on the acquire-time
 * privilege probe, which reads the guest's real `/proc/self/status` — and the
 * test host's node process is correctly NOT deprivileged, so a real agent can
 * never pass it. That gate is proved in `privilege-probe.test.ts` against a
 * scripted guest whose `/proc` the case controls; this file proves the object
 * the gate hands back.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sandbox } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentPreauthFrameTooLargeError } from '../../firecracker/transport.js'
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
const CLAIM_NAME = 'namzu-task-0f2c9a7e-1d44-4e21-a0c0-9f4d2b3c5e77'
const SANDBOX_NAME = 'namzu-task-pool-sandbox-6ab41'
/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '7d1c3e40-8a0f-4c62-9f5b-2ce8a10d4b96'

interface AgentModule {
	startListening(): Promise<Server>
}

let workDir: string
let listener: Server | undefined
let server: FakeApiServer | undefined
let saved: Record<string, string | undefined>
let savedPath: string | undefined
let deleteStatus = 200

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) delete process.env[key]
}

/** Load a FRESH agent module, so module-level bind-token state never leaks. */
async function startAgent(): Promise<number> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	listener = await agent.startListening()
	return (listener.address() as AddressInfo).port
}

/**
 * The control plane behind `destroy()` and the lease: a real HTTP server so
 * the DELETE is a DELETE, and an already-gone object is a real 404/410.
 */
async function startControlPlane(): Promise<FakeApiServer> {
	return await startFakeApiServer((req) => {
		if (req.method === 'DELETE') return { status: deleteStatus, body: { kind: 'Status' } }
		if (req.method === 'PATCH') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})
}

async function build(): Promise<Sandbox> {
	const port = await startAgent()
	server = await startControlPlane()
	const client = createKubernetesClient({
		server: server.url,
		namespace: NAMESPACE,
		getToken: async () => 'sa-token',
	})
	const ownedPath = claimPath(NAMESPACE, CLAIM_NAME)
	return buildKubernetesSandbox({
		name: SANDBOX_NAME,
		rootDir: workDir,
		transport: new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
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
		// An hour, so no renewal tick fires inside a test; `lease-renewal.test.ts`
		// owns the renewal behaviour.
		ttlSeconds: 3_600,
	})
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	clearEnv(AGENT_ENV_KEYS)
	// The guest's TERM→KILL escalation, shortened so a cancellation test
	// spends 50ms proving the kill rather than the production two seconds.
	// Same knobs the Firecracker backend suite sets, for the same reason.
	process.env.NAMZU_AGENT_CANCEL_GRACE_MS = '50'
	process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = '1000'
	deleteStatus = 200
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-sandbox-surface-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	await server?.close()
	server = undefined
	clearEnv(AGENT_ENV_KEYS)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	if (savedPath !== undefined) process.env.PATH = savedPath
	rmSync(workDir, { recursive: true, force: true })
})

describe('identity and file IO', () => {
	it('carries the cluster name as its id, plus the caller root and guest shape', async () => {
		const sandbox = await build()
		// The cluster's own name, verbatim — an id in a log line is also a
		// `kubectl get sandbox` argument.
		expect(sandbox.id).toBe(SANDBOX_NAME)
		expect(sandbox.rootDir).toBe(workDir)
		expect(sandbox.environment).toBe('linux-namespace')
		expect(sandbox.status).toBe('ready')
		await sandbox.destroy()
	})

	it('round-trips a binary file through the guest workspace', async () => {
		const sandbox = await build()
		const payload = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x42, 0xfe, 0x7f])
		await sandbox.writeFile('nested/dir/blob.bin', payload)
		const read = await sandbox.readFile('nested/dir/blob.bin')
		expect(read.equals(payload)).toBe(true)
		await sandbox.destroy()
	})

	it('accepts a string body and reads it back as bytes', async () => {
		const sandbox = await build()
		await sandbox.writeFile('notes.txt', 'héllo wörld')
		expect((await sandbox.readFile('notes.txt')).toString('utf8')).toBe('héllo wörld')
		await sandbox.destroy()
	})

	it('refuses an oversized write with the named pre-auth frame error, before dialing', async () => {
		const sandbox = await build()
		// Every tcp request dials a fresh connection, so its envelope IS that
		// connection's first, not-yet-authenticated frame — the guest's
		// pre-auth ceiling is therefore a per-call budget, not a one-time
		// cost. ~7 MiB raw is ~9.3 MiB base64, clearly over the 8 MiB default.
		const failure = await sandbox
			.writeFile('too-big.bin', Buffer.alloc(7 * 1024 * 1024, 0x62))
			.catch((error: unknown) => error)
		// Surfaced unwrapped, so a caller can catch the class and chunk rather
		// than pattern-match a message.
		expect(failure).toBeInstanceOf(AgentPreauthFrameTooLargeError)
		expect((failure as Error).message).toMatch(/NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES/)
		await sandbox.destroy()
	})
})

describe.skipIf(IS_WINDOWS)('exec', () => {
	it('streams stdout and stderr while the command runs, and reports its exit code', async () => {
		const sandbox = await build()
		const chunks: { stream: string; data: string }[] = []
		const result = await sandbox.exec(
			'/bin/sh',
			['-c', 'echo out-line; echo err-line 1>&2; exit 3'],
			{ onOutput: (chunk) => chunks.push({ ...chunk }) },
		)
		expect(result.exitCode).toBe(3)
		expect(result.stdout).toContain('out-line')
		expect(result.stderr).toContain('err-line')
		expect(result.timedOut).toBe(false)
		expect(chunks.some((c) => c.stream === 'stdout' && c.data.includes('out-line'))).toBe(true)
		expect(chunks.some((c) => c.stream === 'stderr' && c.data.includes('err-line'))).toBe(true)
		await sandbox.destroy()
	})

	it('reports busy while a command is in flight and ready again afterwards', async () => {
		const sandbox = await build()
		let observedBusy = false
		const running = sandbox.exec('/bin/sh', ['-c', 'echo started; sleep 0.3'], {
			onOutput: (chunk) => {
				if (chunk.data.includes('started')) observedBusy = sandbox.status === 'busy'
			},
		})
		await running
		expect(observedBusy).toBe(true)
		expect(sandbox.status).toBe('ready')
		await sandbox.destroy()
	})

	it('terminates the guest process on abort and never reports a clean result', async () => {
		const sandbox = await build()
		const caller = new AbortController()
		let observedReady: (() => void) | undefined
		const ready = new Promise<void>((resolve) => {
			observedReady = resolve
		})

		const running = sandbox.exec(
			'/bin/sh',
			['-c', "trap '' TERM; (trap '' TERM; sleep 0.5; printf late > late.txt) & echo ready; wait"],
			{
				signal: caller.signal,
				onOutput: (chunk) => {
					if (chunk.stream === 'stdout' && chunk.data.includes('ready')) observedReady?.()
				},
			},
		)
		await ready
		caller.abort(new Error('operator cancelled'))

		// The shared RemoteExecutionController's contract: the peer CONFIRMS
		// termination and hands back its own terminal metadata, so what comes
		// out carries the kill — never an exit code 0 with output the host
		// inferred was complete. (A cancellation the peer cannot confirm, or
		// a terminal result that cannot be drained, rejects instead; both are
		// the controller's own paths, exercised in its suite.)
		const result = await running
		expect(result.signal).toBe('SIGKILL')
		expect(result.exitCode).not.toBe(0)
		expect(result.timedOut).toBe(false)
		// And the process really died: the side effect it would have produced
		// half a second later never happens.
		await new Promise((resolve) => setTimeout(resolve, 700))
		await expect(sandbox.readFile('late.txt')).rejects.toThrow()
		await sandbox.destroy()
	})

	it('lists files as {path,size} from the GNU find wire', async () => {
		const sandbox = await build()
		// Shim `find` on PATH so the parser is proven against the exact
		// `-printf '%p\t%s\n'` wire the guest image produces, without
		// depending on the test host having GNU findutils.
		const binDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-bin-')))
		writeFileSync(
			join(binDir, 'find'),
			[
				'#!/bin/sh',
				// Record the invocation too: the parser below is only proven
				// against the real wire if the flags that PRODUCE that wire
				// are the ones actually sent.
				`printf '%s\\n' "$@" > '${binDir}/argv'`,
				`printf '%s\\t%s\\n' '${workDir}/out/result.txt' 9`,
				`printf '%s\\t%s\\n' '${workDir}/out/other.bin' 42`,
				'',
			].join('\n'),
			{ mode: 0o755 },
		)
		process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

		await expect(sandbox.listFiles(`${workDir}/out`)).resolves.toEqual([
			{ path: `${workDir}/out/result.txt`, size: 9 },
			{ path: `${workDir}/out/other.bin`, size: 42 },
		])
		// One argument per line, so the last one carries its own trailing
		// newline plus the separator: `-printf '%p\t%s\n'` with a REAL tab,
		// which is what the two-field parse depends on.
		expect(readFileSync(join(binDir, 'argv'), 'utf8')).toBe(
			`${workDir}/out\n-type\nf\n-printf\n%p\t%s\n\n`,
		)
		rmSync(binDir, { recursive: true, force: true })
		await sandbox.destroy()
	})

	it('reports an absent root as empty rather than failing', async () => {
		const sandbox = await build()
		await expect(sandbox.listFiles(`${workDir}/never-created`)).resolves.toEqual([])
		await sandbox.destroy()
	})
})

describe.skipIf(IS_WINDOWS)('openTcpConnection', () => {
	it('forwards a bidirectional stream to a service on the guest loopback', async () => {
		const sandbox = await build()
		const upstream = createServer((socket) => {
			socket.once('data', (chunk) => socket.end(Buffer.concat([Buffer.from('reply:'), chunk])))
		})
		await new Promise<void>((resolve, reject) => {
			upstream.once('error', reject)
			upstream.listen(0, '127.0.0.1', resolve)
		})
		try {
			const address = upstream.address() as AddressInfo
			const connection = await sandbox.openTcpConnection?.({ port: address.port })
			if (!connection) throw new Error('openTcpConnection is not implemented')
			let output = ''
			const dispose = connection.onData((chunk) => {
				output += Buffer.from(chunk).toString('utf8')
			})
			connection.write('hello')
			await expect(connection.closed).resolves.toBeUndefined()
			expect(output).toBe('reply:hello')
			dispose()
		} finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()))
			await sandbox.destroy()
		}
	})
})

describe.skipIf(process.platform !== 'linux')('openTerminal', () => {
	it('opens a real TTY and destroy() kills and awaits it', async () => {
		const sandbox = await build()
		const terminal = await sandbox.openTerminal?.({
			command: '/bin/sh',
			args: ['-l'],
			cwd: workDir,
			size: { cols: 100, rows: 30 },
		})
		if (!terminal) throw new Error('openTerminal is not implemented')
		let output = ''
		const unsubscribe = terminal.onData((chunk) => {
			output += chunk
		})
		terminal.write('if [ -t 0 ] && [ -t 1 ]; then echo __REAL_PTY__; fi\n')
		await vi.waitFor(() => expect(output).toContain('__REAL_PTY__'))
		// A terminal owns an interactive process tree inside the sandbox, so
		// the SDK's contract makes destroy() responsible for it. Nothing here
		// kills the terminal: destroy() does, and it awaits the exit before
		// it resolves.
		terminal.write('sleep 60\n')

		let exited = false
		void terminal.exited.then(() => {
			exited = true
		})
		await sandbox.destroy()
		// Asserted with NOTHING awaited in between: awaiting `terminal.exited`
		// here would rescue a destroy() that only fired the kill, and the
		// contract is that it awaits the exit.
		expect(exited).toBe(true)
		await terminal.exited
		unsubscribe()
	})
})

describe('destroy', () => {
	it('DELETEs the object it owns exactly once, however many times it is called', async () => {
		const sandbox = await build()
		await sandbox.destroy()
		expect(sandbox.status).toBe('destroyed')
		expect(server?.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)

		await expect(sandbox.destroy()).resolves.toBeUndefined()
		expect(server?.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('treats an object someone else already reaped as successfully released', async () => {
		const sandbox = await build()
		// The TTL, an operator, or the controller got there first.
		deleteStatus = 410
		await expect(sandbox.destroy()).resolves.toBeUndefined()
		expect(sandbox.status).toBe('destroyed')
	})

	it('refuses every later call by name instead of dialing a pod that is gone', async () => {
		const sandbox = await build()
		await sandbox.destroy()

		const expected = expect.objectContaining({ name: 'KubernetesSandboxDestroyedError' })
		await expect(sandbox.exec('/bin/true')).rejects.toThrowError(expected)
		await expect(sandbox.readFile('notes.txt')).rejects.toThrowError(expected)
		await expect(sandbox.writeFile('notes.txt', 'x')).rejects.toThrowError(expected)
		await expect(sandbox.listFiles(workDir)).rejects.toThrowError(expected)
		await expect(sandbox.openTerminal?.({ size: { cols: 80, rows: 24 } })).rejects.toThrowError(
			expected,
		)
		await expect(sandbox.openTcpConnection?.({ port: 9 })).rejects.toThrowError(expected)
		// Each names the operation that was refused, so a stack-less log line
		// still says which call it was.
		await expect(sandbox.exec('/bin/true')).rejects.toThrow(/exec\(\) cannot be admitted/)
	})
})
