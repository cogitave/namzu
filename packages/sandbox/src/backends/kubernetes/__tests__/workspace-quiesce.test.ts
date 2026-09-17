/**
 * Quiescing a workspace: stopping every process the guest is running while
 * the agent stays up to be read through.
 *
 * The guest is the REAL `agent/agent.cjs` and every process is a real
 * process, because every claim here is about what happens to a running
 * program — one that left the session it was started in, one that ignores
 * SIGTERM, one that is halfway through an `exec` — and a scripted peer
 * cannot be wrong about that in the way that matters.
 *
 * **Why the first block runs the agent inside its own PID namespace.** A
 * quiesce's whole point is reaching a process no registry owns: a program
 * `setsid` moved into a session of its own and then reparented to PID 1 is
 * in no process group and no kernel session the agent knows about, and only
 * a scan of `/proc` finds it. In a pod that scan is exactly bounded — the
 * container's PID namespace holds the container's processes and nothing
 * else — but this test host's `/proc` holds the developer's whole machine,
 * and a scan there would signal processes that have nothing to do with any
 * sandbox. The agent therefore performs the general scan only when it is
 * the init of its own PID namespace or was started by it, which is the
 * shape `k8s/entrypoint.sh` gives it (`tini` is PID 1 and starts the
 * agent), and narrows itself to the sessions its own registries own
 * otherwise. So these cases build the real thing: `unshare --user --pid
 * --fork --mount-proc`, an agent whose parent is that namespace's init, and
 * a `/proc` holding nothing but this test's own processes. Nothing about
 * the technique is Kata-specific and no cluster is involved.
 *
 * The second block is the mirror image and the safety proof: an agent
 * loaded in THIS process — `process.ppid` is a test runner, not an init —
 * reports the narrowed scope and leaves a process it does not own alone,
 * running, under the same uid it could have signalled.
 *
 * The third block is the host side, against the fake API server: that the
 * `Suspended` patch is sent only AFTER the quiesce has resolved, that a
 * quiesce the guest could not confirm sends no patch at all and leaves the
 * workspace serving, and that an image whose agent predates the op refuses
 * an explicit `quiesce()` while a `suspend({ quiesce: true })` goes ahead
 * and tells the host it could not be quiesced.
 */

import { execFileSync } from 'node:child_process'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type KubernetesQuiesceReport,
	KubernetesQuiesceUnconfirmedError,
	KubernetesQuiesceUnsupportedError,
} from '../transport.js'
import {
	type KubernetesWorkspace,
	createKubernetesWorkspace,
	suspendKubernetesWorkspace,
} from '../workspace.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	operatingModePatchBody,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { DEPRIVILEGED_PROC_STATUS } from './fixtures/scripted-agent.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
const AGENT_FILE = require_.resolve(AGENT_PATH)

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'quiesce-demo'
const WORKSPACE_NAME = 'namzu-ws-quiesce-demo'
const POD_UID = '1d0b9d6e-1f0a-4a4e-9c8e-51b2a4f1c7aa'

/**
 * Whether this machine can give the agent a PID namespace of its own.
 *
 * Asked once, with a real namespace rather than by reading a sysctl: the
 * answer depends on unprivileged user namespaces being permitted AND on
 * whatever else the host confines them with. Where it is `false` the first
 * block does not run, and nothing in this file pretends it did — the
 * general `/proc` scan is then unproven on that machine rather than proven
 * by a narrower test wearing its name.
 */
const CAN_UNSHARE = ((): boolean => {
	if (IS_WINDOWS) return false
	try {
		execFileSync(
			'unshare',
			['--kill-child', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc', 'true'],
			{ stdio: 'ignore', timeout: 20_000 },
		)
		return true
	} catch {
		return false
	}
})()

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
	sessions: Map<string, { state: string }>
}

let workDir: string
let shimDir: string
let apiServer: FakeApiServer | undefined
let restoreDns: (() => void) | undefined
let saved: Record<string, string | undefined>
let savedPath: string | undefined
let sandboxExists = false
/** Every `PATCH` the cluster answered, so ordering can be asserted. */
let patchedModes: string[] = []

function clearEnv(): void {
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
}

/** A cluster that answers the whole workspace lifecycle. */
async function startCluster(): Promise<FakeApiServer> {
	return await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: TEMPLATE }
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 404, body: { message: 'not found' } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			if (sandboxExists) {
				return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
			}
			sandboxExists = true
			return { status: 201, body: {} }
		}
		if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
			const spec = (req.body as { spec?: { operatingMode?: string } } | undefined)?.spec
			patchedModes.push(spec?.operatingMode ?? 'unknown')
			return { status: 200, body: {} }
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
			return { status: 200, body: { metadata: { name: WORKSPACE_NAME, uid: POD_UID } } }
		}
		return { status: 404, body: { message: 'unexpected' } }
	})
}

async function openWorkspace(
	agentPort: number,
	extra: {
		onQuiesceUnsupported?: (error: KubernetesQuiesceUnsupportedError) => void
		onQuiesceNarrowed?: (report: KubernetesQuiesceReport) => void
	} = {},
): Promise<KubernetesWorkspace> {
	return await createKubernetesWorkspace(
		{
			access: { server: apiServer?.url ?? '', getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort,
			readyTimeoutMs: 5_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		},
		{
			workspaceId: WORKSPACE_ID,
			workingDirectory: workDir,
			...(extra.onQuiesceUnsupported !== undefined
				? { onQuiesceUnsupported: extra.onQuiesceUnsupported }
				: {}),
			...(extra.onQuiesceNarrowed !== undefined
				? { onQuiesceNarrowed: extra.onQuiesceNarrowed }
				: {}),
		},
	)
}

/** A port nothing is listening on yet, for an agent this process will start. */
async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

beforeEach(async () => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	sandboxExists = false
	patchedModes = []
	workDir = mkdtempSync(join(tmpdir(), 'namzu-quiesce-'))
	shimDir = mkdtempSync(join(tmpdir(), 'namzu-shim-'))
	// The acquire-time privilege probe runs `cat /proc/self/status` IN THE
	// GUEST, and this host's node process is correctly not deprivileged.
	// Nothing in this file runs `cat` for any other purpose.
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

describe.skipIf(!CAN_UNSHARE)(
	'a guest in its own PID namespace (needs unprivileged userns)',
	() => {
		let agent: ChildProcess | undefined
		let agentPort = 0

		/**
		 * The agent as a pod runs it: PID 1 is an init that starts it, and
		 * `/proc` holds this container's processes and nothing else.
		 *
		 * `--kill-child` is what makes the teardown honest — killing the outer
		 * `unshare` would otherwise leave the namespace's init running, and with
		 * it every process the case under test was about.
		 */
		async function startNamespacedAgent(): Promise<void> {
			agentPort = await freePort()
			agent = spawn(
				'unshare',
				[
					'--kill-child',
					'--user',
					'--map-root-user',
					'--pid',
					'--fork',
					'--mount-proc',
					'sh',
					'-c',
					`node ${AGENT_FILE} & wait`,
				],
				{
					env: {
						...process.env,
						NAMZU_AGENT_TCP_PORT: String(agentPort),
						NAMZU_AGENT_BIND_TOKEN: POD_UID,
						NAMZU_SANDBOX_WORKSPACE: workDir,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			)
			const deadline = Date.now() + 20_000
			for (;;) {
				try {
					const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
					if (health.reply.ok === true) {
						expect(health.reply.features).toContain('quiesce')
						return
					}
				} catch {
					// Not listening yet.
				}
				if (Date.now() > deadline) throw new Error('the namespaced agent never came up')
				await delay(50)
			}
		}

		/** One framed request against that agent, with its token. */
		async function ask(op: string, body?: unknown): Promise<Record<string, unknown>> {
			const exchange = await sendFramedRequest(agentPort, {
				op,
				token: POD_UID,
				...(body !== undefined ? { body } : {}),
			})
			return exchange.reply
		}

		afterEach(async () => {
			if (agent) {
				agent.kill('SIGKILL')
				await once(agent, 'close').catch(() => undefined)
			}
			agent = undefined
		})

		it('stops a writer that left every session the agent knows about, and keeps serving', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)
			const marker = join(workDir, 'f')

			// A terminal starts it and then goes away. `setsid` puts the writer
			// in a session of its own, so it is in no process group and no
			// kernel session either registry holds — it is reachable by nothing
			// but a scan.
			const terminal = await workspace.openTerminal({
				sessionId: 'shell-1',
				persistent: true,
				size: { cols: 80, rows: 24 },
			})
			terminal.write(
				`setsid sh -c 'while :; do date +%s >> ${marker}; sleep 1; done' </dev/null >/dev/null 2>&1 &\n`,
			)
			const deadline = Date.now() + 10_000
			while (Date.now() < deadline) {
				try {
					if (statSync(marker).size > 0) break
				} catch {
					// Not created yet.
				}
				await delay(100)
			}
			await workspace.killSession('shell-1')
			// The writer outlives the terminal that started it: this is the gap.
			const beforeKill = statSync(marker).size
			await delay(2_500)
			expect(statSync(marker).size).toBeGreaterThan(beforeKill)

			const report = await workspace.quiesce()
			expect(report.scope).toBe('pid-namespace')
			expect(report.rounds).toBeGreaterThan(0)
			expect(report.stopped.some((row) => row.command === 'sleep')).toBe(true)

			// And it is stopped: five of its one-second writes do not happen.
			const afterQuiesce = statSync(marker).size
			await delay(5_000)
			expect(statSync(marker).size).toBe(afterQuiesce)

			// The whole point: the agent is still there to read the disk through.
			const alive = await workspace.exec('/bin/sh', ['-c', 'echo still-serving'])
			expect(alive.exitCode).toBe(0)
			expect(alive.stdout).toContain('still-serving')
			await workspace.writeFile('after.txt', 'written after the quiesce')
			expect((await workspace.readFile('after.txt')).toString('utf8')).toBe(
				'written after the quiesce',
			)

			// A second quiesce has nothing to stop and says so.
			const again = await workspace.quiesce()
			expect(again.stopped).toEqual([])
			expect(again.rounds).toBe(0)
		}, 60_000)

		it('SIGKILLs a program that ignores SIGTERM, reports that signal, and does not fence itself', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)

			// Ignores SIGTERM, so only the escalation can end it.
			await workspace.startDetached({
				sessionId: 'stubborn',
				command: '/bin/sh',
				args: ['-c', "trap '' TERM; while :; do sleep 1; done"],
			})
			// And a command in flight whose GROUP LEADER dies before the rest of
			// its group — the shape that makes an unmarked execution's close
			// handler fence the agent, after which the capture the quiesce was
			// performed for could no longer run.
			const running = workspace.exec('/bin/sh', ['-c', "(trap '' TERM; exec sleep 60) & wait"])
			await delay(500)

			const report = await workspace.quiesce({ graceMs: 1_000 })
			expect(report.stopped.some((row) => row.signal === 'SIGKILL')).toBe(true)

			// The exec RESOLVES, carrying the signal that ended it.
			const result = await running
			expect(result.signal).toBe('SIGTERM')

			// The agent did not retire: it still serves.
			const after = await workspace.exec('/bin/sh', ['-c', 'echo not-fenced'])
			expect(after.exitCode).toBe(0)
			expect(after.stdout).toContain('not-fenced')

			// And the registry says the session ENDED rather than detached, so a
			// host reading `listSessions()` after a quiesce is not told a
			// program that no longer exists is still running.
			const rows = await workspace.listSessions()
			expect(rows.find((row) => row.sessionId === 'stubborn')?.state).toBe('exited')
		}, 60_000)

		it('refuses work that would start a process while it runs, and serves reads throughout', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)
			await workspace.startDetached({
				sessionId: 'stubborn',
				command: '/bin/sh',
				args: ['-c', "trap '' TERM; while :; do sleep 1; done"],
			})
			await workspace.writeFile('during.txt', 'readable throughout')

			// Held open by the SIGTERM-ignoring program for at least one grace
			// window, which is what makes the window observable at all.
			const quiescing = workspace.quiesce({ graceMs: 1_500 })
			await delay(300)

			expect(await ask('reserve-execution')).toEqual({ ok: false, error: 'quiesce_in_progress' })
			expect(await ask('start-detached', { sessionId: 'later', command: '/bin/sh' })).toEqual({
				ok: false,
				error: 'quiesce_in_progress',
			})
			expect(await ask('quiesce')).toEqual({ ok: false, error: 'quiesce_in_progress' })
			const terminal = await sendFramedRequest(agentPort, {
				op: 'terminal',
				token: POD_UID,
				body: { cols: 80, rows: 24 },
			})
			expect(terminal.reply).toEqual({ type: 'error', error: 'quiesce_in_progress' })

			// Reading is NOT refused: a quiesce exists so the host can read.
			const read = await ask('read-file', { path: 'during.txt' })
			expect(read.ok).toBe(true)
			expect((await ask('list-sessions')).ok).toBe(true)

			await quiescing
			// The window is a window, not a state.
			expect((await ask('reserve-execution')).ok).toBe(true)
		}, 60_000)

		it('ends a command in flight and an open terminal, each through its own path', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)

			// A terminal somebody is watching, and a command somebody is
			// awaiting. Neither is told about the quiesce; each finds out the
			// way it would find out about any other ending.
			const terminal = await workspace.openTerminal({ size: { cols: 80, rows: 24 } })
			const running = workspace.exec('/bin/sleep', ['60'])
			await delay(750)

			const report = await workspace.quiesce({ graceMs: 1_000 })
			expect(report.scope).toBe('pid-namespace')
			expect(report.stopped.some((row) => row.command === 'sleep')).toBe(true)

			// The exec RESOLVES with the signal in its result — a quiesce is
			// not an error on the call it ended.
			const result = await running
			expect(result.exitCode).not.toBe(0)
			expect(['SIGTERM', 'SIGKILL']).toContain(result.signal)

			// And the terminal receives its exit rather than a dead socket.
			// (An interactive shell ignores SIGTERM, so this one is always the
			// escalation — which is also why a quiesce with a terminal open
			// spends a full grace window before it finishes.)
			const exit = await Promise.race([terminal.exited, delay(20_000).then(() => 'never' as const)])
			expect(exit).not.toBe('never')
			expect(typeof (exit as { exitCode: number }).exitCode).toBe('number')
		}, 60_000)

		it('refuses a grace window at or above the guest’s cancel-confirmation timeout', async () => {
			await startNamespacedAgent()
			const refusal = await ask('quiesce', { graceMs: 10_000 })
			expect(refusal.error).toBe('quiesce_invalid_grace')
			expect(String(refusal.message)).toContain('NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS')
		}, 60_000)

		it('sends the Suspended patch only after the quiesce has resolved', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)
			const marker = join(workDir, 'g')
			await workspace.exec('/bin/sh', [
				'-c',
				`setsid sh -c 'while :; do date +%s >> ${marker}; sleep 1; done' </dev/null >/dev/null 2>&1 &`,
			])
			await delay(1_500)
			expect(patchedModes).toEqual([])

			// The pod never stops here — the fake cluster keeps answering
			// Running — so the suspend times out waiting for it. What this case
			// is about is what happened BEFORE the patch, and both are recorded.
			await expect(workspace.suspend({ quiesce: true })).rejects.toThrow()
			expect(patchedModes).toEqual(['Suspended'])
			const size = statSync(marker).size
			await delay(3_000)
			expect(statSync(marker).size).toBe(size)
		}, 60_000)
	},
)

describe.skipIf(IS_WINDOWS)('an agent that is not the init of its own PID namespace', () => {
	let agent: AgentModule
	let listener: Server | undefined
	let accepted: Socket[] = []
	let agentPort = 0
	let bystander: ChildProcess | undefined

	async function startAgent(): Promise<void> {
		clearEnv()
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		process.env.NAMZU_SANDBOX_WORKSPACE = workDir
		delete require_.cache[AGENT_FILE]
		agent = require_(AGENT_PATH) as AgentModule
		accepted = []
		listener = createServer((socket) => {
			accepted.push(socket)
			agent.handleConnection(socket)
		})
		await new Promise<void>((resolve, reject) => {
			listener?.once('error', reject)
			listener?.listen(0, '127.0.0.1', () => resolve())
		})
		agentPort = (listener?.address() as AddressInfo).port
	}

	afterEach(async () => {
		for (const socket of accepted) socket.destroy()
		accepted = []
		if (listener) {
			listener.close()
			await once(listener, 'close').catch(() => undefined)
		}
		listener = undefined
		if (bystander?.pid !== undefined) {
			try {
				process.kill(-bystander.pid, 'SIGKILL')
			} catch {
				// Already gone.
			}
		}
		bystander = undefined
	})

	it('narrows itself to the sessions it owns, and leaves everything else running', async () => {
		await startAgent()
		// A process this agent did not start, in a session of its own, under
		// the same uid — exactly what a general scan would sweep up. On a
		// developer's machine that is the test runner's neighbours; in a pod
		// there is nothing else to sweep. The agent must not touch it.
		bystander = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], {
			detached: true,
			stdio: 'ignore',
		})
		expect(bystander.pid).toBeDefined()

		const started = await sendFramedRequest(agentPort, {
			op: 'start-detached',
			token: POD_UID,
			body: { sessionId: 'owned', command: '/bin/sh', args: ['-c', 'while :; do sleep 1; done'] },
		})
		expect(started.reply.ok).toBe(true)

		const report = await sendFramedRequest(agentPort, { op: 'quiesce', token: POD_UID, body: {} })
		expect(report.reply.ok).toBe(true)
		// Reported, never silent: a host can tell a narrowed scan from a
		// complete one.
		expect(report.reply.scope).toBe('owned-sessions')
		const stopped = report.reply.stopped as { pid: number }[]
		expect(stopped.length).toBeGreaterThan(0)
		expect(stopped.some((row) => row.pid === bystander?.pid)).toBe(false)
		expect(agent.sessions.get('owned')?.state).toBe('exited')

		// And the bystander is still there, which is the whole assertion.
		expect(() => process.kill(bystander?.pid ?? 0, 0)).not.toThrow()
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a guest whose image cannot quiesce, and one that refuses', () => {
	let scripted: ScriptedAgent | undefined

	afterEach(async () => {
		await scripted?.close()
		scripted = undefined
	})

	it('refuses an explicit quiesce by class, before anything is asked of the guest', async () => {
		scripted = await startScriptedAgent({ token: POD_UID })
		const workspace = await openWorkspace(scripted.port)
		await expect(workspace.quiesce()).rejects.toBeInstanceOf(KubernetesQuiesceUnsupportedError)
		// The op never went out: a guest that does not advertise it is not
		// asked, so nothing can read its `unknown_op` as "nothing was
		// running".
		expect(scripted.requests.some((request) => request.op === 'quiesce')).toBe(false)
	}, 30_000)

	it('refuses by the same class when the guest advertises the op and does not know it', async () => {
		scripted = await startScriptedAgent({ token: POD_UID, features: ['quiesce'] })
		const workspace = await openWorkspace(scripted.port)
		await expect(workspace.quiesce()).rejects.toBeInstanceOf(KubernetesQuiesceUnsupportedError)
		expect(scripted.requests.some((request) => request.op === 'quiesce')).toBe(true)
	}, 30_000)

	it('suspends anyway against an image that cannot quiesce, and says so', async () => {
		scripted = await startScriptedAgent({ token: POD_UID })
		const told: KubernetesQuiesceUnsupportedError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onQuiesceUnsupported: (error) => told.push(error),
		})
		// The pod never stops in this fixture, so the suspend ends at the
		// wait. The patch is what this case is about, and it went out.
		await expect(workspace.suspend({ quiesce: true })).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
		expect(told[0]?.feature).toBe('quiesce')
	}, 30_000)

	it('sends no patch at all when the guest answers and cannot confirm', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: {
				ok: false,
				error: 'quiesce_unconfirmed',
				message: 'quiesce could not stop pid 41 (dd); it is still live after SIGKILL',
			},
		})
		const workspace = await openWorkspace(scripted.port)
		await expect(workspace.suspend({ quiesce: true })).rejects.toBeInstanceOf(
			KubernetesQuiesceUnconfirmedError,
		)
		// Nothing was changed on the cluster, and the workspace still serves:
		// the state that is true is the one the handle keeps.
		expect(patchedModes).toEqual([])
		expect(workspace.suspended).toBe(false)
		expect((await workspace.exec('cat', ['/proc/self/status'])).exitCode).toBe(0)
	}, 30_000)

	it('quiesces through the destroy that suspends, and not through the one that deletes', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: { ok: true, scope: 'pid-namespace', graceMs: 1_000, rounds: 1, stopped: [] },
		})
		const workspace = await openWorkspace(scripted.port)
		// The default destroy IS a suspend, so it takes the option.
		await expect(workspace.destroy({ quiesce: true })).rejects.toThrow()
		expect(scripted.requests.filter((request) => request.op === 'quiesce')).toHaveLength(1)
		expect(patchedModes).toEqual(['Suspended'])
	}, 30_000)

	it('refuses the option on the verb that never dials the guest, rather than ignoring it', async () => {
		const before = apiServer?.requests.length ?? 0
		await expect(
			suspendKubernetesWorkspace(
				{
					access: { server: apiServer?.url ?? '', getToken: async () => 'sa-token' },
					namespace: NAMESPACE,
					sandboxTemplateName: 'namzu-workspace',
					readyTimeoutMs: 5_000,
					readyPollIntervalMs: 5,
				},
				WORKSPACE_ID,
				{ quiesce: true },
			),
		).rejects.toThrow(/never dials the agent/)
		// Refused before anything went to the cluster: the workspace is left
		// exactly as it was, rather than suspended without the quiesce its
		// caller asked for.
		expect(apiServer?.requests.length).toBe(before)
		expect(patchedModes).toEqual([])
	}, 30_000)

	it('refuses a quiesce the suspend already in flight is not performing', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: { ok: true, scope: 'pid-namespace', graceMs: 1_000, rounds: 1, stopped: [] },
		})
		const workspace = await openWorkspace(scripted.port)
		// A plain suspend, patched and now waiting for a pod this fixture
		// never stops — so it is genuinely in flight for the rest of the case.
		const plain = workspace.suspend().catch(() => undefined)
		const deadline = Date.now() + 5_000
		while (patchedModes.length === 0) {
			if (Date.now() > deadline) throw new Error('the plain suspend never patched')
			await delay(10)
		}

		// Joining THAT would hand this caller a resolved suspend over a guest
		// nothing stopped, which is the one silent failure this feature must
		// not have.
		await expect(workspace.suspend({ quiesce: true })).rejects.toBeInstanceOf(
			KubernetesQuiesceUnconfirmedError,
		)
		await expect(workspace.suspend({ quiesce: true })).rejects.toThrow(/already suspending/)
		// Nothing was asked of the guest on its behalf, and nothing extra was
		// sent to the cluster: the refusal is the whole of it.
		expect(scripted.requests.some((request) => request.op === 'quiesce')).toBe(false)
		await plain
		expect(patchedModes).toEqual(['Suspended'])
	}, 30_000)

	it('lets a caller join a suspend whose quiesce already covers it', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceDelayMs: 300,
			quiesceReply: { ok: true, scope: 'pid-namespace', graceMs: 1_000, rounds: 1, stopped: [] },
		})
		const workspace = await openWorkspace(scripted.port)
		const quiescing = workspace.suspend({ quiesce: true }).catch((err: unknown) => err)
		const deadline = Date.now() + 5_000
		while (!scripted.requests.some((request) => request.op === 'quiesce')) {
			if (Date.now() > deadline) throw new Error('the quiesce request never arrived')
			await delay(10)
		}

		// One asks for less than the flight is doing, one asks for exactly it.
		// Both are satisfied by the transition in flight, so both join it —
		// the same promise, and one quiesce between the three of them.
		const plain = workspace.suspend().catch((err: unknown) => err)
		const alsoQuiescing = workspace.suspend({ quiesce: true }).catch((err: unknown) => err)
		const [first, joined, alsoJoined] = await Promise.all([quiescing, plain, alsoQuiescing])
		expect(joined).toBe(first)
		expect(alsoJoined).toBe(first)
		expect(scripted.requests.filter((request) => request.op === 'quiesce')).toHaveLength(1)
		expect(patchedModes).toEqual(['Suspended'])
	}, 30_000)

	it('tells the host when the guest could only narrow the scan it performed', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: {
				ok: true,
				scope: 'owned-sessions',
				graceMs: 1_000,
				rounds: 1,
				stopped: [{ pid: 7, command: 'sleep', signal: 'SIGTERM' }],
			},
		})
		const narrowed: KubernetesQuiesceReport[] = []
		const workspace = await openWorkspace(scripted.port, {
			onQuiesceNarrowed: (report) => narrowed.push(report),
		})
		// The suspend goes ahead — a narrowed quiesce is still a quiesce —
		// but the one path that cannot read the report is told what it got.
		await expect(workspace.suspend({ quiesce: true })).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(narrowed).toHaveLength(1)
		expect(narrowed[0]?.scope).toBe('owned-sessions')
		expect(narrowed[0]?.stopped).toHaveLength(1)
	}, 30_000)

	it('orders the patch after the quiesce reply, never beside it', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceDelayMs: 400,
			quiesceReply: {
				ok: true,
				scope: 'pid-namespace',
				graceMs: 1_000,
				rounds: 1,
				stopped: [{ pid: 42, command: 'sleep', signal: 'SIGTERM' }],
			},
		})
		const narrowed: KubernetesQuiesceReport[] = []
		const workspace = await openWorkspace(scripted.port, {
			onQuiesceNarrowed: (report) => narrowed.push(report),
		})
		const suspending = workspace.suspend({ quiesce: true }).catch(() => undefined)
		// The guest has the request and has not answered it yet.
		const deadline = Date.now() + 5_000
		while (!scripted.requests.some((request) => request.op === 'quiesce')) {
			if (Date.now() > deadline) throw new Error('the quiesce request never arrived')
			await delay(10)
		}
		expect(patchedModes).toEqual([])
		await suspending
		expect(patchedModes).toEqual(['Suspended'])
		expect(apiServer?.matching('PATCH', '/sandboxes/')[0]?.body).toEqual(
			operatingModePatchBody('Suspended'),
		)
		// A complete scan is not a gap, so nothing is reported as one.
		expect(narrowed).toEqual([])
	}, 30_000)
})
