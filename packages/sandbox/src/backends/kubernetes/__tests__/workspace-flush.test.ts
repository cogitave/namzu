/**
 * Flushing a workspace's writes to its disk before its pod stops.
 *
 * `suspend()` used to patch `operatingMode: Suspended` and wait for the pod
 * to be gone, and the backend and the docs both treated that wait as the
 * point the disk was quiesced. It is not: a stopped pod means only that
 * nothing is writing any more, and whether the guest's dirty pages reached
 * the device is the runtime's business. So the handle now asks the guest to
 * flush — `syncfs(2)` over the workspace mount — before it sends the patch.
 *
 * Two blocks, for two different questions.
 *
 * The first is about ORDER and REFUSAL, and uses the scripted agent because
 * both are control-plane facts: that the patch waits for the flush reply
 * rather than travelling beside it, that a guest which answers and cannot
 * confirm stops the suspend with no patch sent, that an image too old to
 * advertise the op gets the suspend it always got and a callback saying so,
 * and that the verb which never dials a guest refuses the option rather
 * than ignoring it.
 *
 * The second is the round trip, and uses the REAL agent over loopback with
 * a real file on a real filesystem: 5 MiB written, suspended at once with
 * no `sync` of any kind in between, the agent process then SIGKILLed so
 * nothing of its own termination handling can run, a new agent started on
 * the resumed pod's token, and the file read back and compared byte for
 * byte. The kill is the point of that case — it leaves the durability of
 * those bytes resting on what `writeFile` and the host's own flush did
 * before the patch, which is precisely the guarantee under test.
 *
 * What neither block can prove is the device. `fsync` and `syncfs`
 * returning is the strongest promise userspace has, and what a VM runtime
 * does to a guest's page cache while it tears the guest down is measured on
 * a cluster (`k8s/scripts/suspend-resume.mjs`), not here.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KubernetesFlushUnconfirmedError,
	type KubernetesFlushUnreachableError,
	KubernetesFlushUnsupportedError,
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
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import {
	DEPRIVILEGED_PROC_STATUS,
	type ScriptedAgent,
	startScriptedAgent,
} from './fixtures/scripted-agent.js'

const IS_WINDOWS = process.platform === 'win32'
/**
 * The round-trip block runs a REAL `sync -f <workspace>` through the real
 * agent, and `-f` is `syncfs(2)`'s Linux spelling — the one the guest image
 * this backend ships has. On a machine whose `sync` takes no operands the
 * flush would answer `flush_unconfirmed` and the suspend would refuse,
 * which would be the case failing for a reason it is not about. Shimming
 * `sync` away is the other way out and a worse one: what makes this block
 * worth its seconds is that nothing in it is a stand-in.
 */
const IS_LINUX = process.platform === 'linux'
const require_ = createRequire(import.meta.url)
const AGENT_FILE = require_.resolve('../../../../agent/agent.cjs')

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'flush-demo'
const WORKSPACE_NAME = 'namzu-ws-flush-demo'
const FIRST_POD_UID = '5f2c8b1a-3d4e-4a6b-8c9d-0e1f2a3b4c5d'
const SECOND_POD_UID = '7a1b2c3d-4e5f-4061-8273-849506a7b8c9'
/** What a successful flush answers with, as the real agent writes it. */
const FLUSH_OK = { ok: true, durationMs: 3, workspace: '/workspace' }

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

let apiServer: FakeApiServer | undefined
let restoreDns: (() => void) | undefined
let workDir: string
let shimDir: string
let saved: Record<string, string | undefined>
let savedPath: string | undefined
let sandboxExists = false
/** Every `spec.operatingMode` the cluster was asked to write, in order. */
let patchedModes: string[] = []
/** Set by the lifecycle block's cluster; the control-plane one never moves. */
let phase: 'first' | 'suspended' | 'resumed' = 'first'
/**
 * When set, the cycling cluster answers every PATCH with a conflict and
 * records nothing — the shape a write refused by another holder has. Used
 * by the foreign-suspend block, where the point is precisely a patch that
 * does not apply.
 */
let refusePatch = false

function clearEnv(): void {
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
}

/** A port nothing is listening on yet, for an agent this process will start. */
async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

function sandboxBody(mode: string): Record<string, unknown> {
	return {
		metadata: { name: WORKSPACE_NAME },
		spec: {
			operatingMode: mode,
			volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
			podTemplate: TEMPLATE.spec.podTemplate,
		},
		status: {
			conditions: [readyCondition(mode === 'Suspended' ? 'False' : 'True')],
			podIPs: ['127.0.0.1'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: 'agents.x-k8s.io/sandbox-name-hash=ws1',
		},
	}
}

/**
 * A cluster whose pod NEVER stops. Every suspend here therefore ends at the
 * wait, and what each case asserts is what happened before the patch — which
 * is the only part these cases are about.
 */
async function startStuckCluster(): Promise<FakeApiServer> {
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
			return { status: 200, body: sandboxBody('Running') }
		}
		if (req.method === 'GET' && req.path.includes('/pods?')) {
			return {
				status: 200,
				body: { items: [{ metadata: { name: WORKSPACE_NAME, uid: FIRST_POD_UID } }] },
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			return { status: 200, body: { metadata: { name: WORKSPACE_NAME, uid: FIRST_POD_UID } } }
		}
		if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
		return { status: 404, body: { message: 'unexpected' } }
	})
}

/**
 * A cluster that completes the whole cycle: the pod goes away when the
 * workspace is suspended and a DIFFERENT pod comes back when it is resumed,
 * which is what a resume really is — a new pod, a new uid, a new token.
 */
async function startCyclingCluster(): Promise<FakeApiServer> {
	return await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: TEMPLATE }
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 404, body: { message: 'not found' } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			return { status: 201, body: {} }
		}
		if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
			if (refusePatch) {
				return {
					status: 409,
					body: {
						message: `Operation cannot be fulfilled on sandboxes "${WORKSPACE_NAME}": the object has been modified`,
					},
				}
			}
			const mode = (req.body as { spec?: { operatingMode?: string } } | undefined)?.spec
				?.operatingMode
			patchedModes.push(mode ?? 'unknown')
			phase = mode === 'Suspended' ? 'suspended' : 'resumed'
			return { status: 200, body: {} }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			return { status: 200, body: sandboxBody(phase === 'suspended' ? 'Suspended' : 'Running') }
		}
		const podUid = phase === 'resumed' ? SECOND_POD_UID : FIRST_POD_UID
		if (req.method === 'GET' && req.path.includes('/pods?')) {
			if (phase === 'suspended') return { status: 200, body: { items: [] } }
			return {
				status: 200,
				body: {
					items: [
						{ metadata: { name: WORKSPACE_NAME, uid: podUid }, status: { phase: 'Running' } },
					],
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			if (phase === 'suspended') return { status: 404, body: { message: 'gone' } }
			return {
				status: 200,
				body: { metadata: { name: WORKSPACE_NAME, uid: podUid }, status: { phase: 'Running' } },
			}
		}
		if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
		return { status: 404, body: { message: 'unexpected' } }
	})
}

async function openWorkspace(
	agentPort: number,
	extra: {
		onFlushUnsupported?: (error: KubernetesFlushUnsupportedError) => void
		onFlushUnreachable?: (error: KubernetesFlushUnreachableError) => void
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
			...(extra.onFlushUnsupported !== undefined
				? { onFlushUnsupported: extra.onFlushUnsupported }
				: {}),
			...(extra.onFlushUnreachable !== undefined
				? { onFlushUnreachable: extra.onFlushUnreachable }
				: {}),
		},
	)
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	sandboxExists = false
	patchedModes = []
	phase = 'first'
	refusePatch = false
	workDir = mkdtempSync(join(tmpdir(), 'namzu-flush-'))
	shimDir = mkdtempSync(join(tmpdir(), 'namzu-flush-shim-'))
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

describe.skipIf(IS_WINDOWS)('the flush a suspend performs', () => {
	let scripted: ScriptedAgent | undefined

	beforeEach(async () => {
		apiServer = await startStuckCluster()
	})

	afterEach(async () => {
		await scripted?.close()
		scripted = undefined
	})

	it('orders the patch after the flush reply, never beside it', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
			// Held open, so "the patch waited" is observable at all: an
			// instant reply would land in the same tick as the patch.
			flushDelayMs: 300,
		})
		const workspace = await openWorkspace(scripted.port)
		expect(patchedModes).toEqual([])

		const suspend = workspace.suspend().catch(() => undefined)
		await delay(120)
		// The flush is in flight and the cluster has been asked for nothing.
		expect(scripted.requests.some((request) => request.op === 'flush')).toBe(true)
		expect(patchedModes).toEqual([])
		await suspend
		expect(patchedModes).toEqual(['Suspended'])
	}, 30_000)

	it('sends no patch at all when the guest answers and cannot confirm', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: {
				ok: false,
				error: 'flush_unconfirmed',
				message: "flush command 'sync' exited 1: sync: error syncing '/workspace': I/O error",
			},
		})
		const workspace = await openWorkspace(scripted.port)

		await expect(workspace.suspend()).rejects.toBeInstanceOf(KubernetesFlushUnconfirmedError)
		// Nothing was changed on the cluster and the workspace still serves:
		// the state that is true is the one the handle keeps.
		expect(patchedModes).toEqual([])
		expect(workspace.suspended).toBe(false)
		expect((await workspace.exec('cat', ['/proc/self/status'])).exitCode).toBe(0)
	}, 30_000)

	it('suspends anyway against an image that cannot flush, and says so', async () => {
		scripted = await startScriptedAgent({ token: FIRST_POD_UID })
		const told: KubernetesFlushUnsupportedError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnsupported: (error) => told.push(error),
		})

		// The pod never stops in this fixture, so the suspend ends at the
		// wait. The patch is what this case is about, and it went out.
		await expect(workspace.suspend()).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
		expect(told[0]?.feature).toBe('flush')
		// Never sent to a guest that did not advertise it: an `unknown_op`
		// read as "the disk is flushed" is the failure this gate exists for.
		expect(scripted.requests.some((request) => request.op === 'flush')).toBe(false)
	}, 30_000)

	it('suspends a workspace whose guest cannot be reached, and says so', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const told: KubernetesFlushUnreachableError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnreachable: (error) => told.push(error),
		})
		// The agent is gone — crashed, OOM-killed, or its network taken
		// away. Nothing will ever flush this guest again, and the pod is
		// still running and still costing.
		await scripted.close()
		scripted = undefined

		// The minute this case is allowed is the transport's connect retry
		// budget (30s, `DEFAULT_CONNECT_RETRY_BUDGET_MS`): a refused dial is
		// retried for all of it, because a pod that is re-listening after a
		// resume refuses connections for a moment too. That budget is what a
		// suspend against an unreachable guest now spends before it patches
		// — a real cost of the default-on flush, and the reason it is spent
		// rather than refused is what the assertions below say.
		await expect(workspace.suspend()).rejects.toThrow()
		// The patch went out. A default-on flush that could not be ASKED for
		// must not take away the one verb that ends a wedged workspace.
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
		expect(told[0]?.name).toBe('KubernetesFlushUnreachableError')
		// And it names the flush and what the disk is resting on instead,
		// rather than handing the host a bare ECONNREFUSED.
		expect(told[0]?.message).toContain('could not be asked to flush')
		expect(told[0]?.cause).toBeInstanceOf(Error)
	}, 90_000)

	it('destroys a workspace whose guest cannot be reached, and says so', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const told: KubernetesFlushUnreachableError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnreachable: (error) => told.push(error),
		})
		await scripted.close()
		scripted = undefined

		// `destroy()` is the verb a `finally` block calls, and it suspends:
		// the same rule, for the same reason.
		await expect(workspace.destroy()).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
	}, 90_000)

	it('suspends a guest that has fenced itself, which is what clears the fence', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			// The refusal `dispatch` gives every op but `healthz` and
			// `cancel-execution` once the agent has fenced itself.
			flushReply: { ok: false, error: 'agent_retiring' },
		})
		const told: KubernetesFlushUnreachableError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnreachable: (error) => told.push(error),
		})

		// `KubernetesAgentRetiringError` tells its caller that only a new pod
		// clears the fence and that suspend() then resume() is how to get
		// one. A flush that refused the suspend over that same fence would
		// have made the documented way out impossible.
		await expect(workspace.suspend()).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
		expect(String((told[0]?.cause as Error | undefined)?.message)).toContain('agent_retiring')
	}, 30_000)

	it('refuses a suspend the guest answered it could not confirm, even so', async () => {
		// The counterpart of the three cases above, stated as a rule: what
		// stops a suspend is a guest that ANSWERED, never a guest that could
		// not be asked.
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: { ok: false, error: 'flush_unconfirmed', message: 'device is full' },
		})
		const told: KubernetesFlushUnreachableError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnreachable: (error) => told.push(error),
		})

		await expect(workspace.suspend()).rejects.toBeInstanceOf(KubernetesFlushUnconfirmedError)
		expect(patchedModes).toEqual([])
		expect(told).toEqual([])
	}, 30_000)

	it('degrades against a guest that advertises a flush it cannot run', async () => {
		// An image that strips coreutils: `handleFlush` answers
		// `flush_unsupported`, and the host reads that as the image saying
		// it cannot flush — not as a flush that was tried and failed, which
		// would refuse that workspace's every default suspend forever.
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: { ok: false, error: 'flush_unsupported', message: "no 'sync' on PATH" },
		})
		const told: KubernetesFlushUnsupportedError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnsupported: (error) => told.push(error),
		})

		await expect(workspace.suspend()).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(told).toHaveLength(1)
		expect(told[0]).toBeInstanceOf(KubernetesFlushUnsupportedError)
	}, 30_000)

	it('sends no flush at all when the caller turns it off', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const workspace = await openWorkspace(scripted.port)

		await expect(workspace.suspend({ flush: false })).rejects.toThrow()
		expect(patchedModes).toEqual(['Suspended'])
		expect(scripted.requests.some((request) => request.op === 'flush')).toBe(false)
	}, 30_000)

	it('flushes through the destroy that suspends, and not through the one that deletes', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const workspace = await openWorkspace(scripted.port)

		// The default destroy IS a suspend, so it flushes.
		await expect(workspace.destroy()).rejects.toThrow()
		expect(scripted.requests.filter((request) => request.op === 'flush')).toHaveLength(1)
		expect(patchedModes).toEqual(['Suspended'])

		// And the one that deletes does not: the disk is about to go.
		await workspace.destroy({ deleteDisk: true })
		expect(scripted.requests.filter((request) => request.op === 'flush')).toHaveLength(1)
	}, 30_000)

	it('refuses a flush the suspend already in flight is not performing', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const workspace = await openWorkspace(scripted.port)

		const first = workspace.suspend({ flush: false }).catch(() => undefined)
		await delay(20)
		// The transition in flight is patching over writes nobody flushed,
		// and a flush cannot be added to it afterwards — once its state
		// leaves `running` no call is admitted to ask the guest for
		// anything. So the joining caller is refused rather than handed a
		// suspend it would trust the disk on.
		await expect(workspace.suspend()).rejects.toBeInstanceOf(KubernetesFlushUnconfirmedError)
		await first
	}, 30_000)

	it('refuses the option on the verb that never dials the guest, rather than ignoring it', async () => {
		const before = apiServer?.requests.length ?? 0
		await expect(
			suspendKubernetesWorkspace(
				{
					access: { server: apiServer?.url ?? '', getToken: async () => 'sa-token' },
					namespace: NAMESPACE,
					sandboxTemplateName: 'namzu-workspace',
					readyTimeoutMs: 1_000,
					readyPollIntervalMs: 5,
					ingress: 'unverified' as const,
				},
				WORKSPACE_ID,
				{ flush: true },
			),
		).rejects.toThrow(/cannot flush the guest/)
		// Refused before anything was sent: the workspace is untouched.
		expect(apiServer?.requests.length ?? 0).toBe(before)
	}, 30_000)

	it('carries the caller’s own flush timeout into the suspend’s flush', async () => {
		// Without this the only budget a default suspend can flush under is
		// the guest's own NAMZU_AGENT_FLUSH_TIMEOUT_MS, so a workspace that
		// leaves more dirty than 10s of syncfs covers answers
		// `flush_unconfirmed` — the one outcome that STOPS a suspend — with
		// nothing to change but the image's environment.
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: FLUSH_OK,
		})
		const workspace = await openWorkspace(scripted.port)

		await expect(workspace.suspend({ flush: { timeoutMs: 45_000 } })).rejects.toThrow()
		const sent = scripted.requests.find((request) => request.op === 'flush')
		expect((sent?.body as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(45_000)
		expect(patchedModes).toEqual(['Suspended'])
	}, 30_000)

	it('refuses an explicit flush() by class against an image that cannot do it', async () => {
		scripted = await startScriptedAgent({ token: FIRST_POD_UID })
		const workspace = await openWorkspace(scripted.port)

		await expect(workspace.flush()).rejects.toBeInstanceOf(KubernetesFlushUnsupportedError)
		expect(scripted.requests.some((request) => request.op === 'flush')).toBe(false)
	}, 30_000)

	it('hands an explicit flush() the guest’s own report', async () => {
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			flushReply: { ok: true, durationMs: 42, workspace: '/workspace' },
		})
		const workspace = await openWorkspace(scripted.port)

		await expect(workspace.flush({ timeoutMs: 5_000 })).resolves.toEqual({
			durationMs: 42,
			workspace: '/workspace',
		})
		const sent = scripted.requests.find((request) => request.op === 'flush')
		expect((sent?.body as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(5_000)
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('a foreign suspend noticed while the flush is being asked for', () => {
	let scripted: ScriptedAgent | undefined

	beforeEach(async () => {
		apiServer = await startCyclingCluster()
	})

	afterEach(async () => {
		await scripted?.close()
		scripted = undefined
	})

	it('leaves a handle that reports suspended and resumes, when the patch is then refused', async () => {
		// The sequence, which the default-on flush is what makes reachable:
		// another holder suspends this workspace and bumps the epoch; this
		// handle's suspend() dials to flush; the call fails; `admitted` asks
		// once whether somebody else suspended the workspace, finds that
		// they did, and DROPS this handle's session; `flushBeforeSuspend`
		// reports that rather than refusing, so the suspend goes on; and the
		// Suspended patch is then refused by the holder that got there
		// first. The patch's catch used to restore the state captured at
		// entry — 'running' — over a handle with no session, leaving one
		// that admits nothing, reports `suspended: false`, and that
		// `resume()` returns early on without starting anything. There is no
		// verb that recovers such a handle.
		scripted = await startScriptedAgent({
			token: FIRST_POD_UID,
			features: ['flush'],
			// Answered, so this case costs no connect-retry budget. What the
			// flush fails WITH does not matter here: any failure makes
			// `admitted` re-read the object, and the object is what says a
			// foreign suspend has happened.
			flushReply: { ok: false, error: 'agent_retiring' },
		})
		const told: KubernetesFlushUnreachableError[] = []
		const workspace = await openWorkspace(scripted.port, {
			onFlushUnreachable: (error) => told.push(error),
		})

		// Somebody else's suspend lands, and their holder epoch refuses
		// every write this handle sends after it.
		phase = 'suspended'
		refusePatch = true

		await expect(workspace.suspend()).rejects.toThrow()
		// The flush was reported, and the patch really was refused — the
		// cluster recorded no mode at all.
		expect(told).toHaveLength(1)
		expect(patchedModes).toEqual([])
		// THE ASSERTION. `suspended` is what tells a caller the recoverable
		// state apart from a destroyed one, and it has to be true here: the
		// workspace IS suspended on the cluster and this handle knows it.
		expect(workspace.suspended).toBe(true)

		// And the way back works. The other holder's write is out of the way
		// and the resumed pod is a new one with a new token, exactly as a
		// real resume produces.
		refusePatch = false
		scripted.setToken(SECOND_POD_UID)
		await workspace.resume()
		expect(workspace.suspended).toBe(false)
		expect(patchedModes).toEqual(['Running'])
		expect((await workspace.exec('cat', ['/proc/self/status'])).exitCode).toBe(0)
	}, 60_000)
})

describe.skipIf(!IS_LINUX)('a 5 MiB write, suspended at once, read back after a resume', () => {
	let agent: ChildProcess | undefined
	let agentPort = 0

	/** The real agent, on the token the pod of this phase would carry. */
	async function startRealAgent(token: string): Promise<void> {
		agent = spawn(process.execPath, [AGENT_FILE], {
			env: {
				...process.env,
				NAMZU_AGENT_TCP_PORT: String(agentPort),
				NAMZU_AGENT_BIND_TOKEN: token,
				NAMZU_SANDBOX_WORKSPACE: workDir,
			},
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		const deadline = Date.now() + 20_000
		for (;;) {
			try {
				const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
				if (health.reply.ok === true) {
					expect(health.reply.features).toContain('flush')
					return
				}
			} catch {
				// Not listening yet.
			}
			if (Date.now() > deadline) throw new Error('the agent never came up')
			await delay(25)
		}
	}

	/** SIGKILL, so nothing of the agent's own termination handling runs. */
	async function killRealAgent(): Promise<void> {
		if (!agent) return
		const exited = new Promise<void>((resolve) => agent?.once('exit', () => resolve()))
		agent.kill('SIGKILL')
		await exited
		agent = undefined
	}

	beforeEach(async () => {
		apiServer = await startCyclingCluster()
		agentPort = await freePort()
	})

	afterEach(async () => {
		await killRealAgent()
	})

	it('round-trips byte for byte, with no sync of the caller’s own anywhere', async () => {
		await startRealAgent(FIRST_POD_UID)
		const workspace = await openWorkspace(agentPort)
		// Pseudo-random and deterministic: a body reassembled out of order or
		// with a part dropped and padded fails this comparison, where a body
		// of one repeated byte would pass it.
		const body = Buffer.allocUnsafe(5 * 1024 * 1024)
		let x = 0x9e3779b9
		for (let i = 0; i < body.length; i += 1) {
			x ^= x << 13
			x >>>= 0
			x ^= x >> 17
			x ^= x << 5
			x >>>= 0
			body[i] = x & 0xff
		}

		await workspace.writeFile('payload.bin', body)
		// No `sync`, no `exec`, no pause: straight into the suspend, which is
		// the sequence that used to have no durability guarantee at all.
		await workspace.suspend()
		expect(workspace.suspended).toBe(true)
		expect(patchedModes).toEqual(['Suspended'])

		// The pod is gone on the cluster; kill the process that was serving
		// it the hard way, so nothing it might have done on SIGTERM can be
		// what saves these bytes.
		await killRealAgent()
		await startRealAgent(SECOND_POD_UID)

		await workspace.resume()
		expect(workspace.suspended).toBe(false)

		const readBack = await workspace.readFile('payload.bin')
		expect(readBack.length).toBe(body.length)
		expect(readBack.equals(body)).toBe(true)
		// And the file on the host's own filesystem agrees, which is the
		// same claim read from the other side.
		expect(readFileSync(join(workDir, 'payload.bin')).equals(body)).toBe(true)
	}, 120_000)
})
