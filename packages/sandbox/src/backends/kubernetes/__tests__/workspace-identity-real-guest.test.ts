/**
 * What a `pod-replaced` event NAMES, proved against the real guest.
 *
 * The scripted-agent suite beside this one
 * (`workspace-identity-rebind.test.ts`) proves the rebind: the handle follows
 * a pod the controller replaced and the refused call succeeds. This file
 * asks the question that outlives the call — whether the announcement a host
 * subscribed to is one it can ACT on — and it asks it with `agent/agent.cjs`
 * itself on both ends of the move, because the two halves of the answer come
 * from two different places and only a real guest produces one of them:
 *
 *  - the pod uid is the host's, read off the API server and off the bind
 *    token it presents;
 *  - the `guestBootId` is the GUEST's, generated once per agent PROCESS, and
 *    a fixture that returns a constant cannot show that the process on the
 *    other side of a replacement is a different one.
 *
 * So each pod here is a real agent listening on the pod's address, and a
 * replacement is the first one dying — sockets and all — and a second one
 * coming up at the same address with a different bind token, exactly as a
 * Service that outlives its pod delivers it.
 *
 * The case that makes this file worth its runtime is the second one. A pod
 * replaced during a RESUME is the one path the backend singles out as the
 * exception to "the caller's own suspend/resume is silent": the resume binds
 * a pod, somebody else replaces it, and the privilege probe is refused. The
 * handle is between pods there, and an identity assembled from the handle's
 * own transition state would announce a pod replacement while naming neither
 * pod — an event whose only content is "something moved".
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKubernetesWorkspace } from '../../../index.js'
import type { KubernetesGuestRestart } from '../identity.js'
import type { KubernetesWorkspace } from '../workspace.js'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { DEPRIVILEGED_PROC_STATUS } from './fixtures/scripted-agent.js'

const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

/** Only the two exports this file drives; the module has many more. */
interface AgentModule {
	GUEST_BOOT_ID: string
	startListening(): Promise<Server>
}

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'real-guest'
const WORKSPACE_NAME = 'namzu-ws-real-guest'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=rgt'
const SANDBOX_UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const CLAIM_UID = 'cccccccc-3333-4333-8333-cccccccccccc'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const THIRD_POD_UID = '33333333-3333-4333-8333-333333333333'

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

/** One agent process, listening where this workspace's pod listens. */
interface RealGuest {
	/** What the process reports on every authenticated reply. */
	readonly bootId: string
	/** Take the pod away: destroy every connection, then stop listening. */
	stop(): Promise<void>
}

let server: FakeApiServer | undefined
let restoreDns: (() => void) | undefined
let workDir: string
let shimDir: string
let savedEnv: Record<string, string | undefined>
let savedPath: string | undefined
let agentPort = 0
let guests: RealGuest[] = []
/** The Sandbox's mode, driven by the PATCHes the handle sends. */
let operatingMode: 'Running' | 'Suspended'
/** The uid every pod read answers with. */
let boundPodUid: string
/**
 * The uid it moves to, and the pod read after which it moves.
 *
 * A replacement DURING a resume cannot be staged with one variable: the
 * resume's bind must read the pod the API still names, and the re-read its
 * refused probe triggers must find a different one. Both go through the same
 * `GET /pods/<name>`, so the only thing that separates them is which read it
 * is — and the count is armed from the live total right before `resume()`,
 * so nothing an earlier transition happened to read can shift it.
 */
let replacementPodUid: string | undefined
let replaceAfterPodRead: number | undefined
let podReads = 0

async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
	savedPath = process.env.PATH
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-identity-guest-')))
	shimDir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-identity-shim-')))
	// The privilege probe runs `cat /proc/self/status` IN THE GUEST, and this
	// host's vitest process is correctly not deprivileged. Nothing in this
	// file runs `cat` for any other purpose.
	writeFileSync(
		join(shimDir, 'cat'),
		`#!/bin/sh\nprintf '%s' '${DEPRIVILEGED_PROC_STATUS.replace(/'/g, "'\\''")}'\n`,
	)
	chmodSync(join(shimDir, 'cat'), 0o755)
	process.env.PATH = `${shimDir}:${savedPath ?? ''}`
	operatingMode = 'Running'
	boundPodUid = FIRST_POD_UID
	replacementPodUid = undefined
	replaceAfterPodRead = undefined
	podReads = 0
	guests = []
	agentPort = await freePort()
	restoreDns = stubLoopbackDns(() => '127.0.0.1')
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	for (const guest of guests.splice(0)) await guest.stop()
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	server = undefined
	if (savedPath !== undefined) process.env.PATH = savedPath
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
	rmSync(shimDir, { recursive: true, force: true })
})

/**
 * Bring a pod up: a fresh load of the real agent, listening where the
 * workspace dials, holding the uid the API server is reporting as its bind
 * token.
 *
 * Loaded fresh rather than restarted, because `GUEST_BOOT_ID` is generated at
 * module load — which is the whole property under test, and the reason this
 * cannot be a fixture with a settable id.
 */
async function startGuest(token: string): Promise<RealGuest> {
	process.env.NAMZU_AGENT_TCP_PORT = String(agentPort)
	process.env.NAMZU_AGENT_BIND_TOKEN = token
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const module_ = require_(AGENT_PATH) as AgentModule
	const listener = await module_.startListening()
	const sockets = new Set<Socket>()
	listener.on('connection', (socket: Socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
	})
	let stopped = false
	const guest: RealGuest = {
		bootId: module_.GUEST_BOOT_ID,
		stop: async () => {
			if (stopped) return
			stopped = true
			// A pod does not drain: it goes, and every connection the host was
			// holding goes with it. Destroying them is what makes the next
			// call dial the REPLACEMENT rather than keep talking to a socket
			// whose listener merely stopped accepting.
			for (const socket of sockets) socket.destroy()
			sockets.clear()
			await new Promise<void>((resolve) => listener.close(() => resolve()))
		},
	}
	guests.push(guest)
	return guest
}

function livePod(uid: string): Record<string, unknown> {
	return { metadata: { name: WORKSPACE_NAME, uid }, status: { phase: 'Running' } }
}

/**
 * The uid this pod read answers with, moving it first if this is the read the
 * case armed. Counted only on reads that ANSWER — a suspended workspace has
 * no pod and its 404s say nothing about which read is which.
 */
function podUidForRead(): string {
	podReads += 1
	if (
		replacementPodUid !== undefined &&
		replaceAfterPodRead !== undefined &&
		podReads > replaceAfterPodRead
	) {
		boundPodUid = replacementPodUid
		replacementPodUid = undefined
		replaceAfterPodRead = undefined
	}
	return boundPodUid
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) return { status: 201, body: {} }
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const mode = (req.body as { spec?: { operatingMode?: string } }).spec?.operatingMode
		if (mode === 'Suspended') operatingMode = 'Suspended'
		if (mode === 'Running') operatingMode = 'Running'
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/persistentvolumeclaims/')) {
		return {
			status: 200,
			body: { metadata: { name: `workspace-${WORKSPACE_NAME}`, uid: CLAIM_UID } },
		}
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME, uid: SANDBOX_UID },
				spec: { operatingMode, volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates },
				status: {
					conditions: [readyCondition(operatingMode === 'Suspended' ? 'False' : 'True')],
					// Unchanged across every replacement: the Service outlives
					// the pod, which is why the dial keeps working and only the
					// token says anything moved.
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: SELECTOR,
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (operatingMode === 'Suspended') return { status: 200, body: { items: [] } }
		return { status: 200, body: { items: [livePod(podUidForRead())] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (operatingMode === 'Suspended') return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod(podUidForRead()) }
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

async function openWorkspace(): Promise<KubernetesWorkspace> {
	if (!server) throw new Error('fixtures not started')
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort,
			readyTimeoutMs: 8_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: workDir },
	)
}

describe('what a pod-replaced event names, against the real agent', () => {
	it('names the pod that went and the pod that came, and then the process inside it', async () => {
		const first = await startGuest(FIRST_POD_UID)
		const workspace = await openWorkspace()
		// The boot id is the real process's, not a fixture's constant.
		expect(workspace.identity.podUid).toBe(FIRST_POD_UID)
		expect(workspace.identity.guestBootId).toBe(first.bootId)

		const events: KubernetesGuestRestart[] = []
		/** What the handle itself answers while the listener is running. */
		const podSeenByListener: (string | undefined)[] = []
		workspace.onGuestRestart((event) => {
			events.push(event)
			podSeenByListener.push(workspace.identity.podUid)
		})

		// The controller replaces the pod: this one dies, another comes up at
		// the same address under the same name with a new uid.
		await first.stop()
		boundPodUid = SECOND_POD_UID
		const second = await startGuest(SECOND_POD_UID)

		// The call the old bind token would have been refused for.
		expect((await workspace.exec('true')).exitCode).toBe(0)

		expect(events).toHaveLength(1)
		expect(events[0]?.reason).toBe('pod-replaced')
		// Both halves say which guest, and they are not the same guest.
		expect(events[0]?.previous.podUid).toBe(FIRST_POD_UID)
		expect(events[0]?.previous.guestBootId).toBe(first.bootId)
		expect(events[0]?.current.podUid).toBe(SECOND_POD_UID)
		expect(events[0]?.current.podUid).not.toBe(events[0]?.previous.podUid)
		// And the disk under both of them did not move.
		expect(events[0]?.previous.sandboxUid).toBe(SANDBOX_UID)
		expect(events[0]?.current.volumeClaimUids).toEqual({ workspace: CLAIM_UID })
		// A listener that asks the handle where it is gets the replacement,
		// not a blank: the event and the handle agree at the moment of the
		// event, which is the only moment a listener has.
		expect(podSeenByListener).toEqual([SECOND_POD_UID])
		// `current.guestBootId` was undefined at the announcement because the
		// replacement had not answered yet. It has now, and the process it
		// names is a DIFFERENT process — which is the fact no pod uid carries
		// and no fixture can fake.
		expect(workspace.identity.guestBootId).toBe(second.bootId)
		expect(second.bootId).not.toBe(first.bootId)

		await workspace.destroy()
	}, 40_000)

	it('names both pods when a resume finds its own pod already replaced', async () => {
		const first = await startGuest(FIRST_POD_UID)
		const workspace = await openWorkspace()
		const events: KubernetesGuestRestart[] = []
		const podSeenByListener: (string | undefined)[] = []
		workspace.onGuestRestart((event) => {
			events.push(event)
			podSeenByListener.push(workspace.identity.podUid)
		})

		await workspace.suspend()
		await first.stop()
		expect(events).toEqual([])
		// A suspended handle holds no pod, and says so.
		expect(workspace.identity.podUid).toBeUndefined()

		// The resume will bind the pod the API server names for it — and by
		// the time its privilege probe runs, somebody else has replaced THAT
		// pod too. Only the guest knows: the address is the Service's and the
		// bind token is what the new agent refuses.
		boundPodUid = SECOND_POD_UID
		replacementPodUid = THIRD_POD_UID
		replaceAfterPodRead = podReads + 1
		const third = await startGuest(THIRD_POD_UID)

		await workspace.resume()

		// The exception the backend documents: a pod change the caller did not
		// ask for, arriving inside a transition it did.
		expect(events).toHaveLength(1)
		expect(events[0]?.reason).toBe('pod-replaced')
		expect(events[0]?.previous.podUid).toBe(SECOND_POD_UID)
		expect(events[0]?.current.podUid).toBe(THIRD_POD_UID)
		expect(events[0]?.current.podUid).not.toBe(events[0]?.previous.podUid)
		// Neither half is the blank a transition would produce.
		expect(events[0]?.previous.podUid).toBeDefined()
		expect(events[0]?.current.podUid).toBeDefined()
		// The disk is the one the handle was opened on, on both halves.
		expect(events[0]?.previous.sandboxUid).toBe(SANDBOX_UID)
		expect(events[0]?.current.sandboxUid).toBe(SANDBOX_UID)
		// A listener asking the handle mid-resume is answered with the pod it
		// was just told about.
		expect(podSeenByListener).toEqual([THIRD_POD_UID])

		// The resume finished on the replacement, and the handle names it and
		// the process that answered from it.
		expect(workspace.identity.podUid).toBe(THIRD_POD_UID)
		expect(workspace.identity.guestBootId).toBe(third.bootId)
		expect(third.bootId).not.toBe(first.bootId)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		// And still exactly one announcement: the retried probe's own reply is
		// the replacement's baseline, not a second restart.
		expect(events).toHaveLength(1)

		await workspace.destroy()
	}, 40_000)
})
