/**
 * `workspace.pinGuest()`: a non-owning view whose every request is
 * authenticated against one guest agent process.
 *
 * The scripted guest proves what the HOST sends and refuses (zero dispatched
 * operations behind a changed boot id, a refusal instead of a downgrade
 * against an agent without `pinned-guest`, no rebind to a replaced pod). The
 * real `agent/agent.cjs`, in a PID namespace of its own exactly as the
 * quiesce suites run it, proves the AGENT compares its boot id before it
 * dispatches. Nothing here waits on a clock.
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
	KubernetesGuestPinRefusedError,
	KubernetesPinIncompleteError,
	type KubernetesPinnedGuestIdentity,
} from '../identity.js'
import { KubernetesAgentRetiringError } from '../transport.js'
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
const WORKSPACE_ID = 'pin-demo'
const WORKSPACE_NAME = 'namzu-ws-pin-demo'
const SANDBOX_UID = '3c1f0a52-7a52-4c5e-b2f4-0b0d3e2c9a11'
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
					metadata: { name: WORKSPACE_NAME, uid: SANDBOX_UID },
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

async function openWorkspace(agentPort: number): Promise<KubernetesWorkspace> {
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
		{ workspaceId: WORKSPACE_ID, workingDirectory: workDir },
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

const PINNED_FEATURES = ['quiesce', 'quiesce-idle', 'sessions', 'guest-boot-id', 'pinned-guest']

/** What a caller reads off a workspace the guest has answered: every pinned field, complete. */
function pinnedIdentityOf(workspace: KubernetesWorkspace): KubernetesPinnedGuestIdentity {
	const { sandboxUid, podUid, guestBootId } = workspace.identity
	if (sandboxUid === undefined || podUid === undefined || guestBootId === undefined) {
		throw new Error('the workspace has not been answered by a guest that reports an identity')
	}
	return { sandboxUid, podUid, guestBootId }
}

describe.skipIf(IS_WINDOWS)('workspace.pinGuest() against a scripted guest', () => {
	let scripted: ScriptedAgent | undefined

	afterEach(async () => {
		await scripted?.close()
		scripted = undefined
	})

	async function start(features: readonly string[] = PINNED_FEATURES) {
		scripted = await startScriptedAgent({
			token: POD_UID,
			features,
			guestBootId: 'boot-a',
			quiesceReply: { ok: true, scope: 'pid-namespace', graceMs: 0, rounds: 0, stopped: [] },
		})
		const workspace = await openWorkspace(scripted.port)
		return { workspace, agent: scripted }
	}

	it('refuses an incomplete identity synchronously, naming the fields', async () => {
		const { workspace } = await start()
		const complete = pinnedIdentityOf(workspace)
		for (const field of ['sandboxUid', 'podUid', 'guestBootId'] as const) {
			for (const bad of [undefined, '']) {
				const attempt = () =>
					workspace.pinGuest({
						...complete,
						[field]: bad,
					} as unknown as KubernetesPinnedGuestIdentity)
				expect(attempt).toThrow(KubernetesPinIncompleteError)
				try {
					attempt()
				} catch (err) {
					expect((err as KubernetesPinIncompleteError).missing).toEqual([field])
				}
			}
		}
		expect(() => workspace.pinGuest({ ...complete, volumeClaimUids: { workspace: '' } })).toThrow(
			KubernetesPinIncompleteError,
		)
		expect(() => workspace.pinGuest(undefined as never)).toThrow(KubernetesPinIncompleteError)
	}, 30_000)

	it('serves every call through the pinned envelope while the guest is the pinned one', async () => {
		const { workspace, agent } = await start()
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		const before = agent.requests.length

		expect((await view.exec('echo', ['hi'])).exitCode).toBe(0)
		await view.writeFile('/workspace/a.txt', 'hello')
		await view.readFile('/workspace/a.txt')
		await view.listFiles('/workspace')
		const terminal = await view.openTerminal({ size: { cols: 80, rows: 24 } })
		await terminal.kill?.()
		const tcp = await view.openTcpConnection({ host: '127.0.0.1', port: 1 })
		tcp.destroy?.()
		const idle = await view.quiesce({ onlyIfIdle: true })
		expect(idle.rounds).toBe(0)

		const sent = agent.requests.slice(before).filter((request) => request.op !== 'healthz')
		expect(sent.length).toBeGreaterThan(0)
		// Every non-healthz frame is the envelope, with the pinned id and the token outside it.
		for (const request of sent) {
			expect(request.op).toBe('pinned')
			expect(request.token).toBe(POD_UID)
			expect((request.body as { expectedGuestBootId: string }).expectedGuestBootId).toBe('boot-a')
		}
		// What the guest ran is the ordinary ops, unwrapped.
		const ran = agent.dispatched.slice(-sent.length).map((request) => request.op)
		expect(ran).toContain('write-file')
		expect(ran).toContain('read-file')
		expect(ran).toContain('quiesce')
	}, 30_000)

	it('dispatches nothing at a guest whose boot id changed, and says which one answered', async () => {
		const { workspace, agent } = await start()
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		// The container restarted inside the same pod: same token, same address, a new process.
		agent.setGuestBootId('boot-b')
		const dispatchedBefore = agent.dispatched.length

		const calls: Array<() => Promise<unknown>> = [
			() => view.exec('echo', ['hi']),
			() => view.readFile('/workspace/a.txt'),
			() => view.writeFile('/workspace/a.txt', 'x'),
			() => view.listFiles('/workspace'),
			() => view.openTerminal({ size: { cols: 80, rows: 24 } }),
			() => view.openTcpConnection({ host: '127.0.0.1', port: 1 }),
			() => view.quiesce(),
		]
		for (const call of calls) {
			const error = await call().catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
			const refused = error as KubernetesGuestPinRefusedError
			expect(refused.reason).toBe('guest-replaced')
			expect(refused.freshGuestBootId).toBe('boot-b')
			expect(refused.expected.guestBootId).toBe('boot-a')
		}
		// The guest compared first: not one operation ran.
		expect(agent.dispatched.length).toBe(dispatchedBefore)
		// And the view did not rebind the workspace behind it.
		expect(workspace.identity.podUid).toBe(POD_UID)
	}, 30_000)

	it('refuses before dialing once the workspace itself has seen the change', async () => {
		const { workspace, agent } = await start()
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		agent.setGuestBootId('boot-b')
		// An ordinary call on the workspace observes the new process.
		await workspace.readFile('/workspace/a.txt')
		expect(workspace.identity.guestBootId).toBe('boot-b')

		const connections = agent.connections.length
		const dispatchedBefore = agent.dispatched.length
		const error = await view.exec('echo').catch((err: unknown) => err)
		expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
		expect((error as KubernetesGuestPinRefusedError).reason).toBe('identity-changed')
		expect((error as KubernetesGuestPinRefusedError).field).toBe('guestBootId')
		expect(agent.connections.length).toBe(connections)
		expect(agent.dispatched.length).toBe(dispatchedBefore)
	}, 30_000)

	it('refuses a pin whose pod or sandbox is not the workspace', async () => {
		const { workspace, agent } = await start()
		const complete = pinnedIdentityOf(workspace)
		const connections = agent.connections.length
		for (const [field, wrong] of [
			['podUid', 'other-pod'],
			['sandboxUid', 'other-sandbox'],
		] as const) {
			const view = workspace.pinGuest({ ...complete, [field]: wrong })
			const error = await view.exec('echo').catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
			expect((error as KubernetesGuestPinRefusedError).reason).toBe('identity-changed')
			expect((error as KubernetesGuestPinRefusedError).field).toBe(field)
		}
		const claims = workspace.pinGuest({
			...complete,
			volumeClaimUids: { workspace: 'not-the-claim' },
		})
		const claimError = await claims.exec('echo').catch((err: unknown) => err)
		expect((claimError as KubernetesGuestPinRefusedError).field).toBe('volumeClaimUids')
		expect(agent.connections.length).toBe(connections)
	}, 30_000)

	it('refuses against an agent without pinned-guest and sends nothing but healthz', async () => {
		const { workspace, agent } = await start(['quiesce', 'quiesce-idle', 'sessions'])
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		const before = agent.requests.length
		const dispatchedBefore = agent.dispatched.length
		for (const call of [() => view.exec('echo'), () => view.writeFile('/workspace/a', 'x')]) {
			const error = await call().catch((err: unknown) => err)
			expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
			expect((error as KubernetesGuestPinRefusedError).reason).toBe('guest-unsupported')
		}
		const sent = agent.requests.slice(before)
		expect(sent.every((request) => request.op === 'healthz')).toBe(true)
		expect(agent.dispatched.length).toBe(dispatchedBefore)
	}, 30_000)

	it('does not follow a replaced pod: the refused token is a typed refusal and the workspace is not rebound', async () => {
		const { workspace, agent } = await start()
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		const podReads = () => apiServer?.requests.filter((r) => r.path.includes('/pods')).length ?? 0
		const readsBefore = podReads()
		agent.setToken('replacement-pod-uid')
		const error = await view.readFile('/workspace/a.txt').catch((err: unknown) => err)
		expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
		expect((error as KubernetesGuestPinRefusedError).reason).toBe('pod-replaced')
		expect(podReads()).toBe(readsBefore)
		expect(workspace.identity.podUid).toBe(POD_UID)
	}, 30_000)

	it('tells a fenced guest it pinned from a replaced one, by id', async () => {
		const { workspace, agent } = await start()
		const view = workspace.pinGuest(pinnedIdentityOf(workspace))
		agent.fence()
		const fenced = await view.exec('echo').catch((err: unknown) => err)
		expect(fenced).toBeInstanceOf(KubernetesAgentRetiringError)
		// The same process: its id is the pinned one, so this is fencing, not replacement.
		expect((fenced as KubernetesAgentRetiringError).guestBootId).toBe('boot-a')
		// A different process that is also fenced reports itself as replaced, with its id.
		agent.setGuestBootId('boot-b')
		const replaced = await view.readFile('/workspace/a.txt').catch((err: unknown) => err)
		expect(replaced).toBeInstanceOf(KubernetesGuestPinRefusedError)
		expect((replaced as KubernetesGuestPinRefusedError).freshGuestBootId).toBe('boot-b')
	}, 30_000)

	it('reads its pin once: mutating the object it was given changes nothing', async () => {
		const { workspace, agent } = await start()
		const given = { ...pinnedIdentityOf(workspace) } as {
			-readonly [K in keyof KubernetesPinnedGuestIdentity]: KubernetesPinnedGuestIdentity[K]
		}
		const view = workspace.pinGuest(given)
		given.guestBootId = 'boot-b'
		agent.setGuestBootId('boot-b')
		const error = await view.exec('echo').catch((err: unknown) => err)
		expect(error).toBeInstanceOf(KubernetesGuestPinRefusedError)
		expect(view.expected.guestBootId).toBe('boot-a')
		expect(Object.isFrozen(view.expected)).toBe(true)
	}, 30_000)
})

describe.skipIf(!CAN_UNSHARE)('workspace.pinGuest() against the real agent (needs userns)', () => {
	let agent: ChildProcess | undefined
	let agentPort = 0

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
		// A refused connect is the only signal the agent is not up yet; Vitest's own timeout ends a real hang.
		for (;;) {
			try {
				const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
				if (health.reply.ok === true) {
					expect(health.reply.features).toContain('pinned-guest')
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

	const writeEnvelope = (expectedGuestBootId: string, name: string) => ({
		op: 'pinned',
		token: POD_UID,
		body: {
			expectedGuestBootId,
			request: {
				op: 'write-file',
				body: {
					path: join(workDir, name),
					content: Buffer.from('x').toString('base64'),
					encoding: 'base64',
				},
			},
		},
	})

	it('dispatches on a matching boot id and refuses a forced mismatch before dispatch', async () => {
		await startNamespacedAgent()
		const workspace = await openWorkspace(agentPort)
		const identity = pinnedIdentityOf(workspace)
		const view = workspace.pinGuest(identity)

		// The matching id, through the host's view.
		await view.writeFile(join(workDir, 'matched.txt'), 'pinned')
		expect((await view.readFile(join(workDir, 'matched.txt'))).toString()).toBe('pinned')
		expect((await view.exec('/bin/sh', ['-c', `touch ${join(workDir, 'by-exec')}`])).exitCode).toBe(
			0,
		)
		expect(statSync(join(workDir, 'by-exec')).isFile()).toBe(true)

		// And on the raw wire: a matching id writes, a forced mismatch writes NOTHING.
		const matched = await sendFramedRequest(
			agentPort,
			writeEnvelope(identity.guestBootId, 'raw-ok'),
		)
		expect(matched.reply.ok).toBe(true)
		expect(statSync(join(workDir, 'raw-ok')).isFile()).toBe(true)

		const refused = await sendFramedRequest(
			agentPort,
			writeEnvelope('some-other-process', 'raw-refused'),
		)
		expect(refused.reply.ok).toBe(false)
		expect(refused.reply.error).toBe(`guest_mismatch:${identity.guestBootId}`)
		expect(refused.reply.guestBootId).toBe(identity.guestBootId)
		expect(() => statSync(join(workDir, 'raw-refused'))).toThrow()

		// A wrapped healthz or a nested pin is malformed, never dispatched.
		for (const inner of [{ op: 'healthz' }, { op: 'pinned', body: {} }]) {
			const bad = await sendFramedRequest(agentPort, {
				op: 'pinned',
				token: POD_UID,
				body: { expectedGuestBootId: identity.guestBootId, request: inner },
			})
			expect(bad.reply.error).toBe('bad_pinned_request')
		}
	}, 60_000)
})
