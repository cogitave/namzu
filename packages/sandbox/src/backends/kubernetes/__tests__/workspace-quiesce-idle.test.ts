/**
 * Idle-only quiesce (`quiesce({ onlyIfIdle: true })`): the report-only mode.
 * Real agent in its own PID namespace for what the guest sees; the scripted
 * guest for what the host sends and refuses. Cloned from the fixtures of
 * workspace-quiesce.test.ts. Original header follows.
 *
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
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KubernetesQuiesceBusyError,
	type KubernetesQuiesceReport,
	KubernetesQuiesceUnconfirmedError,
	KubernetesQuiesceUnsupportedError,
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

const HAS_PYTHON_THREAD_EXIT = ((): boolean => {
	if (IS_WINDOWS) return false
	try {
		execFileSync(
			'python3',
			[
				'-c',
				'import threading,ctypes\nthreading.Thread(target=lambda: None).start()\nctypes.CDLL(None).pthread_exit(None)',
			],
			{ stdio: 'ignore', timeout: 10_000 },
		)
		return true
	} catch {
		return false
	}
})()

const IDLE_REPLY = { ok: true, scope: 'pid-namespace', graceMs: 0, rounds: 0, stopped: [] }

describe.skipIf(IS_WINDOWS)('quiesce({ onlyIfIdle }) on the host side', () => {
	let scripted: ScriptedAgent | undefined

	afterEach(async () => {
		await scripted?.close()
		scripted = undefined
	})

	const quiesceRequests = () =>
		(scripted?.requests ?? []).filter((request) => request.op === 'quiesce')

	it('refuses before sending when the guest has quiesce but not quiesce-idle', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: IDLE_REPLY,
		})
		const workspace = await openWorkspace(scripted.port)
		const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
		expect(error).toBeInstanceOf(KubernetesQuiesceUnsupportedError)
		expect((error as KubernetesQuiesceUnsupportedError).feature).toBe('quiesce-idle')
		// The old agent would ignore the field and stop the work: nothing went out.
		expect(quiesceRequests()).toHaveLength(0)
	}, 30_000)

	it('still sends the ordinary quiesce to a guest without quiesce-idle, with no new field', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce'],
			quiesceReply: { ok: true, scope: 'pid-namespace', graceMs: 1_000, rounds: 1, stopped: [] },
		})
		const workspace = await openWorkspace(scripted.port)
		await workspace.quiesce({ graceMs: 500 })
		expect(quiesceRequests().map((request) => request.body)).toEqual([{ graceMs: 500 }])
	}, 30_000)

	it('resolves with a rounds-0 report from an idle guest and sends only idleOnly', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce', 'quiesce-idle'],
			quiesceReply: IDLE_REPLY,
		})
		const workspace = await openWorkspace(scripted.port)
		const report = await workspace.quiesce({ onlyIfIdle: true })
		expect(report).toEqual({ scope: 'pid-namespace', graceMs: 0, rounds: 0, stopped: [] })
		expect(quiesceRequests().map((request) => request.body)).toEqual([{ idleOnly: true }])
	}, 30_000)

	it('rejects with a typed busy error that carries what the guest saw', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce', 'quiesce-idle'],
			quiesceReply: {
				ok: false,
				error: 'quiesce_busy',
				message: 'the guest is not idle',
				busy: [{ pid: 12, command: 'dd', state: 'R' }, { pid: 'x' }],
				busyTotal: 40,
				registries: [
					{ source: 'execution', state: 'starting' },
					{ source: 'other', state: 'q' },
				],
			},
		})
		const workspace = await openWorkspace(scripted.port)
		const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
		expect(error).toBeInstanceOf(KubernetesQuiesceBusyError)
		const busy = error as KubernetesQuiesceBusyError
		expect(busy.busy).toEqual([{ pid: 12, command: 'dd', state: 'R' }])
		expect(busy.busyTotal).toBe(40)
		expect(busy.registries).toEqual([{ source: 'execution', state: 'starting' }])
		// A busy answer is not an unconfirmed one: a caller retries this.
		expect(busy).not.toBeInstanceOf(KubernetesQuiesceUnconfirmedError)
		// And the workspace is untouched.
		expect(patchedModes).toEqual([])
		expect(workspace.suspended).toBe(false)
	}, 30_000)

	it('refuses, as unconfirmed, a guest that cannot classify or cannot see its namespace', async () => {
		for (const refusal of ['quiesce_idle_unclassifiable', 'quiesce_idle_scope_narrowed']) {
			scripted = await startScriptedAgent({
				token: POD_UID,
				features: ['quiesce', 'quiesce-idle'],
				quiesceReply: { ok: false, error: refusal, message: 'cannot tell' },
			})
			const workspace = await openWorkspace(scripted.port)
			const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesQuiesceUnconfirmedError)
			expect((error as KubernetesQuiesceUnconfirmedError).reason).toBe(refusal)
			await scripted.close()
			scripted = undefined
			sandboxExists = false
		}
	}, 30_000)

	it('captures the options before any await, so a later mutation cannot widen the request', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce', 'quiesce-idle'],
			quiesceReply: IDLE_REPLY,
		})
		const workspace = await openWorkspace(scripted.port)
		const options: { onlyIfIdle?: boolean; graceMs?: number } = { onlyIfIdle: true }
		const pending = workspace.quiesce(options)
		options.onlyIfIdle = false
		options.graceMs = 900
		await pending
		expect(quiesceRequests().map((request) => request.body)).toEqual([{ idleOnly: true }])
	}, 30_000)

	it('rejects graceMs beside onlyIfIdle, and a non-boolean onlyIfIdle, sending nothing', async () => {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features: ['quiesce', 'quiesce-idle'],
			quiesceReply: IDLE_REPLY,
		})
		const workspace = await openWorkspace(scripted.port)
		await expect(workspace.quiesce({ onlyIfIdle: true, graceMs: 100 })).rejects.toBeInstanceOf(
			TypeError,
		)
		await expect(
			workspace.quiesce({ onlyIfIdle: 'yes' as unknown as boolean }),
		).rejects.toBeInstanceOf(TypeError)
		expect(quiesceRequests()).toHaveLength(0)
	}, 30_000)
})

describe.skipIf(!CAN_UNSHARE)(
	'quiesce({ onlyIfIdle }) against the real agent (needs userns)',
	() => {
		let agent: ChildProcess | undefined
		let agentPort = 0

		async function startNamespacedAgent(extraEnv: Record<string, string> = {}): Promise<void> {
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
						...extraEnv,
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			)
			// Retried on the connection itself, with no clock: a refused connect is
			// the only signal that the agent is not up yet, and Vitest's own test
			// timeout is what ends a genuine hang.
			for (;;) {
				try {
					const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
					if (health.reply.ok === true) {
						expect(health.reply.features).toContain('quiesce-idle')
						return
					}
				} catch {
					// Not listening yet.
				}
				await delay(50)
			}
		}

		afterEach(async () => {
			if (agent) {
				agent.kill('SIGKILL')
				await once(agent, 'close').catch(() => undefined)
			}
			agent = undefined
		})

		it('reports idle on a quiet namespace, then busy for an escapee it never signals', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)
			const sigfile = join(workDir, 'got-sigterm')

			const idle = await workspace.quiesce({ onlyIfIdle: true })
			expect(idle).toEqual({ scope: 'pid-namespace', graceMs: 0, rounds: 0, stopped: [] })

			// A process in a session of its own, in no registry. If anything
			// signalled it, the trap would leave the file.
			const started = await workspace.exec('/bin/sh', [
				'-c',
				`setsid sh -c "trap 'touch ${sigfile}' TERM; while :; do sleep 1; done" </dev/null >/dev/null 2>&1 & echo started`,
			])
			expect(started.exitCode).toBe(0)

			const first = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(first).toBeInstanceOf(KubernetesQuiesceBusyError)
			const seen = (first as KubernetesQuiesceBusyError).busy
			expect(seen.length).toBeGreaterThan(0)
			expect(seen.some((row) => row.command === 'sh' || row.command === 'sleep')).toBe(true)

			// Asking again finds the very same process: it was not touched.
			const second = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(second).toBeInstanceOf(KubernetesQuiesceBusyError)
			expect((second as KubernetesQuiesceBusyError).busy.map((row) => row.pid)).toEqual(
				seen.map((row) => row.pid),
			)
			expect(() => statSync(sigfile)).toThrow()

			// The ordinary quiesce stops it, and only then is the guest idle.
			const stopping = await workspace.quiesce()
			expect(stopping.stopped.length).toBeGreaterThan(0)
			expect(await workspace.quiesce({ onlyIfIdle: true })).toEqual(idle)
		}, 60_000)

		it('counts a session the registry holds as busy, and an execution still starting', async () => {
			await startNamespacedAgent()
			const workspace = await openWorkspace(agentPort)
			await workspace.startDetached({
				sessionId: 'worker',
				command: '/bin/sh',
				args: ['-c', 'while :; do sleep 1; done'],
			})
			const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesQuiesceBusyError)
			expect((error as KubernetesQuiesceBusyError).registries).toContainEqual({
				source: 'session',
				state: 'running',
			})

			// A reserved execution is a start dispatched that /proc cannot show.
			await workspace.quiesce()
			const reply = await sendFramedRequest(agentPort, {
				op: 'reserve-execution',
				token: POD_UID,
				body: {},
			})
			expect(reply.reply.ok).toBe(true)
			const reserved = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(reserved).toBeInstanceOf(KubernetesQuiesceBusyError)
			expect((reserved as KubernetesQuiesceBusyError).registries).toContainEqual({
				source: 'execution',
				state: 'reserved',
			})
		}, 60_000)

		it.skipIf(!HAS_PYTHON_THREAD_EXIT)(
			'counts a zombie leader whose non-leader thread still runs',
			async () => {
				await startNamespacedAgent()
				const workspace = await openWorkspace(agentPort)
				const started = await workspace.exec('/bin/sh', [
					'-c',
					`setsid python3 -c "import threading,time,ctypes
threading.Thread(target=time.sleep,args=(600,)).start()
ctypes.CDLL(None).pthread_exit(None)" </dev/null >/dev/null 2>&1 & echo started`,
				])
				expect(started.exitCode).toBe(0)
				// The leader may not have exited yet, in which case it is simply a
				// live process; either way the guest is busy. Wait for the leader to
				// become the zombie by asking until a `Z` row shows (the agent
				// answers each ask immediately; Vitest's timeout ends a hang).
				let zombie: { state: string } | undefined
				while (zombie === undefined) {
					const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
					expect(error).toBeInstanceOf(KubernetesQuiesceBusyError)
					zombie = (error as KubernetesQuiesceBusyError).busy.find((row) => row.state === 'Z')
					if (zombie === undefined) await delay(20)
				}
				expect(zombie.state).toBe('Z')
			},
			60_000,
		)

		it('refuses to call a narrowed agent idle', async () => {
			await startNamespacedAgent({ NAMZU_AGENT_QUIESCE_SCOPE: 'owned-sessions' })
			const workspace = await openWorkspace(agentPort)
			const error = await workspace.quiesce({ onlyIfIdle: true }).catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesQuiesceUnconfirmedError)
			expect((error as KubernetesQuiesceUnconfirmedError).reason).toBe(
				'quiesce_idle_scope_narrowed',
			)
		}, 60_000)

		it('rejects idleOnly beside graceMs and a non-boolean idleOnly at the wire', async () => {
			await startNamespacedAgent()
			const both = await sendFramedRequest(agentPort, {
				op: 'quiesce',
				token: POD_UID,
				body: { idleOnly: true, graceMs: 100 },
			})
			expect(both.reply.error).toBe('quiesce_invalid_idle_only')
			const wrong = await sendFramedRequest(agentPort, {
				op: 'quiesce',
				token: POD_UID,
				body: { idleOnly: 'yes' },
			})
			expect(wrong.reply.error).toBe('quiesce_invalid_idle_only')
		}, 60_000)
	},
)
