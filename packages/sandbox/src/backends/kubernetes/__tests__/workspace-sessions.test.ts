/**
 * Workspace terminals and background programs that outlive the host process.
 *
 * The guest is the REAL `agent/agent.cjs` on a loopback socket and every
 * program is a real process, because everything this feature claims is about
 * what happens to a running process when a socket goes away — and a scripted
 * peer cannot be wrong about that in the way that matters. The cluster
 * underneath is the fake API server, so host B arrives through the real
 * adopt path rather than through a handle this file built by hand.
 *
 * These are proved here and nowhere else:
 *
 *  - **A closed connection is a detach.** Host A's socket is destroyed the
 *    way a deploy destroys it; the shell keeps running, keeps printing into
 *    the ring, and host B — a handle from a second `createKubernetesWorkspace`
 *    and a transport instance that never saw the first one — finds it by
 *    name, replays what it missed, and can type into and resize the same
 *    shell.
 *  - **A kill reaches the whole session.** This is the case that proves the
 *    old comment true. `handleTerminal` claimed its group kill "reaches the
 *    shell and every descendant" and it did not: util-linux `script` starts
 *    the shell in a NEW session, so the kill reached `script` alone and a
 *    job backgrounded with `&` kept running with no terminal until the pod
 *    stopped. Both cases track the job by PID — the agent's own child list
 *    proves nothing, because the job is reparented away from it — and the
 *    job ignores SIGHUP, so what kills it can only be the signal this change
 *    sends and never the PTY hanging up.
 *  - **Nothing falls back.** Against a guest whose `healthz` features are
 *    empty every session verb is refused BY CLASS, and the guest's registry
 *    is still empty afterwards: a refusal that had already started a shell
 *    would be worse than no feature at all.
 *  - **There is ONE retained-output primitive.** A session's log is asserted
 *    to be the very `OutputLog` class `attach-execution` reads, and its
 *    overflow accounting is proved through it: a program that outruns the
 *    ring with nobody attached keeps running and the loss is reported as a
 *    count, never as a shorter stream that looks complete.
 *  - **One attachment at a time**, and the loser is told by name — while a
 *    one-shot READ displaces nobody, because a read is not an attachment and
 *    a host polling a shell's tail must not end the terminal it is polling.
 *  - **A signal means the same thing on every connection.** The allow-list is
 *    applied in one place, so a `SIGSTOP` is coerced to `SIGTERM` whether it
 *    arrived on the connection that opened the terminal or on a later
 *    attachment; an uncoerced one would wedge the session in state `T`.
 *  - **The registry is bounded.** A running session is never evicted to make
 *    room, an exited one is forgotten once its window passes, and the slot it
 *    held comes back.
 *  - **The registry is the pod's memory.** A fresh agent process comes back
 *    with no sessions, which is what a resumed workspace gets.
 *
 * Why the `cat` shim: `createKubernetesWorkspace` gates on the acquire-time
 * privilege probe, which runs `cat /proc/self/status` IN THE GUEST, and the
 * test host's node process is correctly not deprivileged. Nothing in this
 * file runs `cat` for any other purpose.
 */

import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentSessionDetachedError } from '../../firecracker/transport.js'
import {
	KubernetesAgentTransport,
	KubernetesSessionRefusedError,
	KubernetesSessionsUnsupportedError,
	type KubernetesWorkspaceTerminal,
} from '../transport.js'
import { type KubernetesWorkspace, createKubernetesWorkspace } from '../workspace.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { DEPRIVILEGED_PROC_STATUS } from './fixtures/scripted-agent.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'session-demo'
const WORKSPACE_NAME = 'namzu-ws-session-demo'
const POD_UID = '7c3f2e11-9a44-4b52-8c1d-6f0e5a2b7d38'
const SIZE = { cols: 80, rows: 24 }

/**
 * A job that ignores SIGHUP, backgrounded in the terminal's shell.
 *
 * The `trap` is what makes the case honest. Whether a plain `sleep 300 &`
 * survives its shell depends on which shell the image ships and what that
 * shell does when the PTY hangs up — dash leaves it running (the shipped
 * bookworm image's `/bin/sh`), bash kills it. Ignoring SIGHUP removes that
 * variable: the job can now only be ended by a signal sent TO it, which is
 * exactly the thing under test. A SIG_IGN disposition survives fork and
 * exec, so `sleep` inherits it.
 */
const HUP_IMMUNE_JOB = "(trap '' HUP; exec sleep 300) &\necho JOBPID $!\n"

/** A one-request HTTP server, printing when it is up. */
const LISTENER_PROGRAM = (port: number) =>
	`require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1', () => console.log('LISTENING'))`

const TEMPLATE = {
	metadata: { name: 'namzu-workspace', namespace: NAMESPACE },
	spec: {
		service: true,
		volumeClaimTemplates: [
			{
				metadata: { name: 'workspace' },
				spec: { accessModes: ['ReadWriteOnce'], volumeMode: 'Block' },
			},
		],
		podTemplate: {
			metadata: { labels: { 'sandbox.namzu.ai/template': 'namzu-workspace' } },
			spec: {
				containers: [
					{
						name: 'main',
						image: 'namzu/agent:test',
						volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
					},
				],
			},
		},
	},
}

interface AgentModule {
	AGENT_FEATURES: string[]
	handleConnection(socket: Socket): void
	OutputLog: new (maxBytes: number) => unknown
	sessions: Map<string, { log: unknown; state: string }>
}

let workDir: string
let shimDir: string
let agent: AgentModule
let listener: Server | undefined
let agentPort = 0
let accepted: Socket[] = []
let apiServer: FakeApiServer | undefined
let restoreDns: (() => void) | undefined
let saved: Record<string, string | undefined>
let savedPath: string | undefined
/** Whether a Sandbox already stands under this name. The POST sets it. */
let sandboxExists = false

function clearEnv(): void {
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
}

/** Put the agent behind a loopback listener we can take away and give back. */
async function listen(port = 0): Promise<Server> {
	const server = createServer((socket) => {
		accepted.push(socket)
		agent.handleConnection(socket)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => resolve())
	})
	return server
}

/** Load a FRESH agent module: its registry and config are module state. */
async function startAgent(env: Record<string, string> = {}): Promise<void> {
	clearEnv()
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	delete require_.cache[require_.resolve(AGENT_PATH)]
	agent = require_(AGENT_PATH) as AgentModule
	accepted = []
	listener = await listen()
	agentPort = (listener.address() as AddressInfo).port
}

/**
 * The host process going away: every socket it holds is severed. The pod
 * keeps running — this is the host's side of the wire disappearing, which is
 * what a deploy, a crash and an OOM kill all look like from the guest.
 */
function severHostConnections(): void {
	for (const socket of accepted) socket.destroy()
	accepted = []
}

/** A transport instance that never saw the first host's sockets. */
function transport(): KubernetesAgentTransport {
	return new KubernetesAgentTransport({
		kind: 'tcp',
		host: '127.0.0.1',
		port: agentPort,
		token: POD_UID,
	})
}

/** A cluster that answers the whole workspace lifecycle, adopt included. */
async function startCluster(): Promise<FakeApiServer> {
	return await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: TEMPLATE }
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 404, body: { message: 'not found' } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			// The second create takes the ADOPT path, which is how a second
			// host process really reaches a workspace that already stands.
			if (sandboxExists) {
				return {
					status: 409,
					body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` },
				}
			}
			sandboxExists = true
			return { status: 201, body: {} }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			return {
				status: 200,
				body: {
					metadata: { name: WORKSPACE_NAME },
					spec: {
						operatingMode: 'Running',
						volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
						podTemplate: TEMPLATE.spec.podTemplate,
					},
					status: {
						conditions: [readyCondition()],
						podIPs: ['127.0.0.1'],
						serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
						selector: 'agents.x-k8s.io/sandbox-name-hash=ws1',
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods?')) {
			return {
				status: 200,
				body: { items: [{ metadata: { name: WORKSPACE_NAME, uid: POD_UID } }] },
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			return {
				status: 200,
				body: { metadata: { name: WORKSPACE_NAME, uid: POD_UID } },
			}
		}
		return { status: 404, body: { message: 'unexpected' } }
	})
}

async function openWorkspace(): Promise<KubernetesWorkspace> {
	return await createKubernetesWorkspace(
		{
			access: {
				server: apiServer?.url ?? '',
				getToken: async () => 'sa-token',
			},
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort,
			readyTimeoutMs: 5_000,
			readyPollIntervalMs: 5,
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: workDir },
	)
}

/**
 * Whether a pid is a live process.
 *
 * A zombie reads as GONE: `process.kill(pid, 0)` succeeds against one, so a
 * liveness check built on it would pass for a process the kernel has already
 * killed and nobody has reaped yet.
 */
function isAlive(pid: number): boolean {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
		return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
	} catch {
		return false
	}
}

/** The same wait, for a condition that has to ask the guest. */
async function waitForReply(
	condition: () => Promise<boolean>,
	what: string,
	timeoutMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await condition()) return
		await delay(25)
	}
	throw new Error(`timed out waiting for ${what}`)
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (condition()) return
		await delay(25)
	}
	throw new Error(`timed out waiting for ${what}`)
}

/** One session's row, or nothing if the guest is not holding it. */
async function sessionRow(
	workspace: KubernetesWorkspace,
	sessionId: string,
): Promise<{ readonly state: string } | undefined> {
	return (await workspace.listSessions()).find((row) => row.sessionId === sessionId)
}

/** Everything one terminal printed, from the moment it was attached. */
function collect(terminal: KubernetesWorkspaceTerminal): {
	readonly text: string
} {
	const box = { text: '' }
	terminal.onData((chunk) => {
		box.text += chunk
	})
	return box
}

beforeEach(async () => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	sandboxExists = false
	workDir = mkdtempSync(join(tmpdir(), 'namzu-session-'))
	shimDir = mkdtempSync(join(tmpdir(), 'namzu-shim-'))
	// See the file header. The probe's `cat` and nothing else.
	writeFileSync(
		join(shimDir, 'cat'),
		`#!/bin/sh\nprintf '%s' '${DEPRIVILEGED_PROC_STATUS.replace(/'/g, "'\\''")}'\n`,
	)
	chmodSync(join(shimDir, 'cat'), 0o755)
	process.env.PATH = `${shimDir}:${savedPath ?? ''}`
	restoreDns = stubLoopbackDns()
	apiServer = await startCluster()
})

afterEach(async () => {
	for (const socket of accepted) socket.destroy()
	accepted = []
	if (listener) {
		listener.close()
		await once(listener, 'close').catch(() => undefined)
	}
	listener = undefined
	restoreDns?.()
	restoreDns = undefined
	await apiServer?.close()
	apiServer = undefined
	clearEnv()
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	if (savedPath !== undefined) process.env.PATH = savedPath
	rmSync(workDir, { recursive: true, force: true })
	rmSync(shimDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('a terminal that outlives the host process', () => {
	it('hands a running shell to a second host process, replayed from offset zero', async () => {
		await startAgent()
		const hostA = await openWorkspace()
		const shell = await hostA.openTerminal({
			sessionId: 'shell-1',
			persistent: true,
			size: SIZE,
		})
		const seenByA = collect(shell)
		shell.write('echo FIRST-MARKER\n')
		await waitUntil(() => seenByA.text.includes('FIRST-MARKER'), 'the first command to echo')

		// Host A dies mid-session: a deploy, a crash, an OOM kill. Nothing
		// distinguishes them from the guest's side.
		severHostConnections()
		// `exited` REJECTS rather than resolving: the shell did not exit, and
		// claiming an exit code for a program that is still running is the
		// confusion this feature exists to remove.
		await expect(shell.exited).rejects.toBeInstanceOf(AgentSessionDetachedError)

		const hostB = await openWorkspace()
		expect(hostB.origin).toBe('adopted-running')
		const listed = await hostB.listSessions()
		expect(listed.map((row) => row.sessionId)).toEqual(['shell-1'])
		expect(listed[0]?.state).toBe('running')
		expect(listed[0]?.kind).toBe('terminal')
		expect(listed[0]?.attached).toBe(false)

		const rejoined = await hostB.attachTerminal('shell-1', { fromOffset: 0 })
		const seenByB = collect(rejoined)
		// The replay: everything the shell printed before this process existed.
		await waitUntil(() => seenByB.text.includes('FIRST-MARKER'), 'the replayed output')
		rejoined.write('echo SECOND-MARKER\n')
		await waitUntil(() => seenByB.text.includes('SECOND-MARKER'), 'the new command to run')
		// And it is the SAME shell, not a fresh one: resize reaches the real
		// PTY, which only the process that owns it can answer for.
		rejoined.resize({ cols: 100, rows: 40 })
		rejoined.write('stty size\n')
		await waitUntil(() => seenByB.text.includes('40 100'), 'the resized PTY to report itself')

		rejoined.detach()
		await hostB.killSession('shell-1')
		await hostA.destroy({ deleteDisk: true })
	}, 30_000)

	it('kills every process in the session, including a job the shell backgrounded', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const shell = await workspace.openTerminal({
			sessionId: 'shell-kill',
			persistent: true,
			size: SIZE,
		})
		const seen = collect(shell)
		shell.write(HUP_IMMUNE_JOB)
		await waitUntil(() => /JOBPID (\d+)/.test(seen.text), 'the backgrounded job to report its pid')
		const jobPid = Number(/JOBPID (\d+)/.exec(seen.text)?.[1])
		expect(isAlive(jobPid)).toBe(true)

		const killed = await workspace.killSession('shell-kill')
		expect(killed.state).toBe('exited')
		// Tracked by PID. The agent's own child list would prove nothing: the
		// job is the shell's child, and the shell is in a session `script`
		// created, which is exactly why the old process-group kill missed it.
		await waitUntil(() => !isAlive(jobPid), 'the backgrounded job to be gone')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)

	it('leaves nothing behind when a non-persistent terminal loses its connection', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		// No sessionId, no `persistent`: the terminal this backend has always
		// offered, on the wire request it has always sent.
		const shell = await workspace.openTerminal({ size: SIZE })
		const seen = collect(shell)
		shell.write(HUP_IMMUNE_JOB)
		await waitUntil(() => /JOBPID (\d+)/.test(seen.text), 'the backgrounded job to report its pid')
		const jobPid = Number(/JOBPID (\d+)/.exec(seen.text)?.[1])
		expect(isAlive(jobPid)).toBe(true)

		severHostConnections()
		// The teardown this terminal always performed now reaches the whole
		// session. Before this change the job survived its terminal and ran
		// until the pod stopped, unreachable by every op.
		await waitUntil(() => !isAlive(jobPid), 'the backgrounded job to be gone')
		// And it is not a session: nothing was registered for it.
		expect(agent.sessions.size).toBe(0)
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a background program that outlives the host process', () => {
	it('keeps serving its port, is read by offset, and reports how it ended', async () => {
		await startAgent()
		const hostA = await openWorkspace()
		// A free port, chosen by binding one and letting it go.
		const probe = createServer()
		await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
		const port = (probe.address() as AddressInfo).port
		probe.close()
		await once(probe, 'close')

		const started = await hostA.startDetached({
			sessionId: 'server-1',
			command: process.execPath,
			args: ['-e', LISTENER_PROGRAM(port)],
		})
		expect(started.kind).toBe('detached')
		expect(started.state).toBe('running')
		// Read through the workspace surface, which is also what proves the
		// program is actually up before anything dials its port.
		await waitForReply(
			async () =>
				(await hostA.readSession('server-1', { fromOffset: 0 })).chunk.includes('LISTENING'),
			'the detached server to report it is listening',
		)

		// Host A goes away. The program has no connection to lose: it was
		// never bound to one.
		severHostConnections()

		const hostB = transport()
		const connection = await hostB.openTcpConnection({ port })
		let answer = ''
		connection.onData((chunk) => {
			answer += Buffer.from(chunk).toString('utf8')
		})
		connection.write('GET / HTTP/1.0\r\n\r\n')
		await waitUntil(() => answer.includes('ok'), "the detached server's reply")
		connection.destroy()

		const output = await hostB.readSession('server-1', { fromOffset: 0 })
		expect(output.chunk).toContain('LISTENING')
		expect(output.status).toBe('running')
		expect(output.droppedBytes).toBe(0)
		expect(output.nextOffset).toBeGreaterThan(0)

		const ended = await hostB.killSession('server-1')
		expect(ended.state).toBe('exited')
		// Killed, not exited: the kernel stopped it, and the SDK's job
		// vocabulary has a third member for exactly that difference.
		const after = await hostB.readSession('server-1', {
			fromOffset: output.nextOffset,
		})
		expect(after.status).toBe('killed')
		expect(after.chunk).toBe('')
		expect(after.nextOffset).toBe(output.nextOffset)
		await hostA.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('the one retained-output primitive', () => {
	it('keeps a program running past the ring and reports what it dropped', async () => {
		// A ring far smaller than what the program prints, so the overflow is
		// reached in milliseconds rather than megabytes.
		await startAgent({ NAMZU_AGENT_SESSION_LOG_BYTES: '128' })
		const workspace = await openWorkspace()
		await workspace.startDetached({
			sessionId: 'noisy',
			command: process.execPath,
			args: ['-e', "setInterval(() => console.log('x'.repeat(40)), 5)"],
		})
		const record = agent.sessions.get('noisy')
		// The SAME class `attach-execution` reads. Two registries would mean
		// two overflow accountings and two ways to read an offset.
		expect(record?.log).toBeInstanceOf(agent.OutputLog)

		await waitUntil(
			() => (agent.sessions.get('noisy')?.log as { droppedBytes: number }).droppedBytes > 0,
			'the ring to overflow with nobody attached',
		)
		const output = await workspace.readSession('noisy', { fromOffset: 0 })
		expect(output.droppedBytes).toBeGreaterThan(0)
		// Bounded by the ring, not by what was printed.
		expect(Buffer.byteLength(output.chunk)).toBeLessThanOrEqual(128)
		expect(output.nextOffset).toBeGreaterThan(128)
		// And the program never blocked on having nobody attached.
		expect(output.status).toBe('running')
		await workspace.killSession('noisy')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('one attachment at a time', () => {
	it('ends the first attachment by name when a second one arrives', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const first = await workspace.openTerminal({
			sessionId: 'shell-2',
			persistent: true,
			size: SIZE,
		})
		const second = await workspace.attachTerminal('shell-2', { fromOffset: 0 })
		await expect(first.exited).rejects.toThrow(/superseded/)
		// The session itself is untouched: the loser was an observer.
		const rows = await workspace.listSessions()
		expect(rows[0]?.state).toBe('running')
		expect(rows[0]?.attached).toBe(true)
		second.detach()
		await workspace.killSession('shell-2')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('reading a session is not attaching to it', () => {
	it('leaves a live attachment attached, typing and unbroken', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const shell = await workspace.openTerminal({
			sessionId: 'shell-read',
			persistent: true,
			size: SIZE,
		})
		// `exited` rejects on a detach, so this flag IS the question: did the
		// read end the terminal it was reading?
		let ended: unknown
		void shell.exited.catch((error: unknown) => {
			ended = error
		})
		const seen = collect(shell)
		shell.write('echo BEFORE-READ\n')
		await waitUntil(() => seen.text.includes('BEFORE-READ'), 'the first command to echo')

		// What a host polling a shell's tail does, in the loop the docs
		// describe: read, come back with the offset, read again.
		const first = await workspace.readSession('shell-read', { fromOffset: 0 })
		expect(first.chunk).toContain('BEFORE-READ')
		expect(first.status).toBe('running')
		const second = await workspace.readSession('shell-read', {
			fromOffset: first.nextOffset,
		})
		expect(second.droppedBytes).toBe(0)

		// Still the session's one attachment, and still the same shell.
		const rows = await workspace.listSessions()
		expect(rows[0]?.attached).toBe(true)
		expect(rows[0]?.state).toBe('running')
		shell.write('echo AFTER-READ\n')
		await waitUntil(() => seen.text.includes('AFTER-READ'), 'the shell to answer after the read')
		expect(ended).toBeUndefined()

		shell.detach?.()
		await workspace.killSession('shell-read')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a signal means the same thing on every connection', () => {
	it('coerces one the guest does not allow, opened or attached', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		// On the connection that opened the terminal, which is where the
		// allow-list has always been applied.
		const opened = await workspace.openTerminal({
			sessionId: 'signal-opened',
			persistent: true,
			size: SIZE,
		})
		opened.kill('SIGSTOP')
		await waitForReply(
			async () => (await sessionRow(workspace, 'signal-opened'))?.state === 'exited',
			'the opening connection to coerce SIGSTOP and end the session',
		)

		// And on an attachment, where an uncoerced SIGSTOP would wedge the
		// session in state T: stopped, unkillable by anything but SIGKILL, and
		// reported by `kill-session` as still running after its confirm wait.
		const first = await workspace.openTerminal({
			sessionId: 'signal-attached',
			persistent: true,
			size: SIZE,
		})
		first.detach?.()
		const attached = await workspace.attachTerminal('signal-attached', { fromOffset: 0 })
		attached.kill('SIGSTOP')
		await waitForReply(
			async () => (await sessionRow(workspace, 'signal-attached'))?.state === 'exited',
			'the attachment to coerce SIGSTOP and end the session',
		)
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('the registry is bounded', () => {
	it('refuses a session past the cap and forgets an exited one after its window', async () => {
		await startAgent({
			NAMZU_AGENT_MAX_SESSIONS: '1',
			NAMZU_AGENT_SESSION_TERMINAL_TTL_MS: '50',
		})
		const workspace = await openWorkspace()
		const idle = ['-e', 'setInterval(() => {}, 1000)']
		await workspace.startDetached({
			sessionId: 'holds-the-slot',
			command: process.execPath,
			args: idle,
		})
		// A RUNNING session is never evicted to make room: its program has
		// nowhere else to go, so the next start is refused before it spawns
		// anything rather than quietly taking the slot.
		const refused = await workspace
			.startDetached({ sessionId: 'over-the-cap', command: process.execPath, args: idle })
			.catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(KubernetesSessionRefusedError)
		expect((refused as KubernetesSessionRefusedError).reason).toBe('session_capacity')
		expect((await workspace.listSessions()).map((row) => row.sessionId)).toEqual(['holds-the-slot'])

		// An EXITED one is kept for its retention window and no longer: the
		// record and its ring go, and the slot they held comes back.
		await workspace.killSession('holds-the-slot')
		await delay(80)
		expect(await workspace.listSessions()).toEqual([])
		const reused = await workspace.startDetached({
			sessionId: 'over-the-cap',
			command: process.execPath,
			args: idle,
		})
		expect(reused.state).toBe('running')
		await workspace.killSession('over-the-cap')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)("the registry is the pod's memory", () => {
	it('comes back empty when the agent process is replaced', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		await workspace.startDetached({
			sessionId: 'gone-with-the-pod',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		})
		expect(await workspace.listSessions()).toHaveLength(1)
		await workspace.killSession('gone-with-the-pod')

		// A resumed workspace is a NEW pod running a fresh agent. Restarting
		// the agent process here is that, minus the cluster: the registry is
		// module state, so a fresh module is a fresh pod.
		if (listener) {
			listener.close()
			await once(listener, 'close')
		}
		await startAgent()
		const afterRestart = transport()
		expect(await afterRestart.listSessions()).toEqual([])
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a guest image without the session registry', () => {
	it('refuses every session verb by name and starts nothing', async () => {
		await startAgent()
		// The guest's own advertisement, emptied in place: `healthz` reads
		// this array, so the host sees an image that has never heard of
		// sessions.
		agent.AGENT_FEATURES.splice(0, agent.AGENT_FEATURES.length)
		const workspace = await openWorkspace()

		await expect(
			workspace.openTerminal({
				sessionId: 'nope',
				persistent: true,
				size: SIZE,
			}),
		).rejects.toBeInstanceOf(KubernetesSessionsUnsupportedError)
		await expect(workspace.attachTerminal('nope')).rejects.toBeInstanceOf(
			KubernetesSessionsUnsupportedError,
		)
		await expect(
			workspace.startDetached({
				sessionId: 'nope',
				command: process.execPath,
				args: ['-e', ''],
			}),
		).rejects.toBeInstanceOf(KubernetesSessionsUnsupportedError)
		await expect(workspace.listSessions()).rejects.toBeInstanceOf(
			KubernetesSessionsUnsupportedError,
		)
		await expect(workspace.killSession('nope')).rejects.toBeInstanceOf(
			KubernetesSessionsUnsupportedError,
		)
		await expect(workspace.readSession('nope')).rejects.toBeInstanceOf(
			KubernetesSessionsUnsupportedError,
		)
		// Refused BEFORE anything was started, and never downgraded to a
		// connection-bound terminal.
		expect(agent.sessions.size).toBe(0)

		// A plain terminal still works against the same image: only the
		// session surface is refused.
		const plain = await workspace.openTerminal({ size: SIZE })
		expect(plain.sessionId).toBeUndefined()
		plain.kill('SIGKILL')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('every session op is behind the bind token', () => {
	it('refuses an unauthenticated caller, exactly as every other op does', async () => {
		await startAgent()
		// `healthz` is the only op exempt from the gate, and the gate runs on
		// the connection's first frame rather than per op — so a new op is
		// covered by construction. Asserted anyway, because the docs promise
		// it and a future refactor could move the check.
		for (const request of [
			{ op: 'list-sessions' },
			{ op: 'kill-session', body: { sessionId: 'anything' } },
			{
				op: 'start-detached',
				body: { sessionId: 'anything', command: '/bin/true' },
			},
			{ op: 'attach-session', body: { sessionId: 'anything' } },
		]) {
			const exchange = await sendFramedRequest(agentPort, request)
			expect(exchange.reply).toEqual({ ok: false, error: 'unauthorized' })
		}
		expect(agent.sessions.size).toBe(0)
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a session the guest does not hold', () => {
	it('is refused by class, with the reason on the error', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const failure = await workspace.readSession('never-existed').catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesSessionRefusedError)
		expect((failure as KubernetesSessionRefusedError).reason).toBe('unknown_session')
		await expect(workspace.killSession('never-existed')).rejects.toBeInstanceOf(
			KubernetesSessionRefusedError,
		)
		// The two STREAM verbs refuse by the same class as the request/reply
		// ones. The guest refuses them with an `error` frame rather than an
		// `{ ok: false }` body, and a caller should not have to know which.
		const attachFailure = await workspace
			.attachTerminal('never-existed')
			.catch((error: unknown) => error)
		expect(attachFailure).toBeInstanceOf(KubernetesSessionRefusedError)
		expect((attachFailure as KubernetesSessionRefusedError).reason).toBe('unknown_session')

		const held = await workspace.openTerminal({
			sessionId: 'taken',
			persistent: true,
			size: SIZE,
		})
		const openFailure = await workspace
			.openTerminal({ sessionId: 'taken', persistent: true, size: SIZE })
			.catch((error: unknown) => error)
		expect(openFailure).toBeInstanceOf(KubernetesSessionRefusedError)
		expect((openFailure as KubernetesSessionRefusedError).reason).toBe('session_exists')
		held.detach?.()
		await workspace.killSession('taken')
		await workspace.destroy({ deleteDisk: true })
	}, 30_000)
})
