/**
 * What a workspace handle is bound to, and what it does when the thing
 * behind the name moves underneath it.
 *
 * The failure this suite exists for is the DEFAULT deployment's, which is
 * what makes it worth a file of its own. Under `agentAddress: 'service'` the
 * Service FQDN outlives the pod and goes on resolving, so when the controller
 * replaces a pod — an eviction, a node drain, a resume some other process
 * asked for — every call still CONNECTS, and the new agent refuses each one
 * because the handle is presenting the old pod's uid as its bind token. The
 * refusal used to arrive in two unrelated shapes (a named error for
 * `exec`/`listFiles`, a bare `Error('unauthorized')` for `writeFile`,
 * `readFile`, `openTerminal` and `openTcpConnection`), neither of which said
 * anything about a pod, and nothing recovered from either.
 *
 * So the fixture moves the things a real cluster moves and nothing else:
 *
 *  - the pod behind the name gets a new uid, and the guest binds to it,
 *    while the Sandbox stays Ready and Running and the address is unchanged.
 *    That is a replacement, and a handle must follow it;
 *  - the SANDBOX gets a new uid under the same deterministic name, which is
 *    what "somebody deleted and recreated this workspace" looks like from
 *    here. That is a different disk, and a handle must refuse it;
 *  - the agent answers with a different `guestBootId` while the pod, the uid
 *    and the token stay exactly as they were. That is the kubelet restarting
 *    the container in place, and NOTHING in the Kubernetes API reports it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point, like the other workspace suites:
// the public `createKubernetesWorkspace` is the surface a host calls.
import { createKubernetesWorkspace } from '../../../index.js'
import {
	type KubernetesGuestRestart,
	KubernetesWorkspaceGuestGoneError,
	KubernetesWorkspaceReplacedError,
} from '../identity.js'
import { KubernetesAgentUnauthorizedError } from '../transport.js'
import {
	type KubernetesWorkspace,
	type KubernetesWorkspaceCancellationNotice,
	KubernetesWorkspaceSuspendedError,
} from '../workspace.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'identity'
const WORKSPACE_NAME = 'namzu-ws-identity'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=idt'
const SANDBOX_UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const OTHER_SANDBOX_UID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const CLAIM_UID = 'cccccccc-3333-4333-8333-cccccccccccc'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const FIRST_BOOT_ID = 'dddddddd-4444-4444-8444-dddddddddddd'
const SECOND_BOOT_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'

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

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
/** The Sandbox's own uid, and the live pod's. Both move independently. */
let sandboxUid: string
let livePodUid: string
let operatingMode: 'Running' | 'Suspended'
/** The object is gone entirely — somebody deleted the workspace. */
let sandboxDeleted: boolean
/** The PVC read is refused, as an un-upgraded Role refuses it. */
let claimForbidden: boolean
/** Milliseconds the Sandbox GET is held, so a burst of callers overlaps. */
let sandboxGetDelayMs: number

beforeEach(async () => {
	sandboxUid = SANDBOX_UID
	livePodUid = FIRST_POD_UID
	operatingMode = 'Running'
	sandboxDeleted = false
	claimForbidden = false
	sandboxGetDelayMs = 0
	agent = await startScriptedAgent({
		host: '0.0.0.0',
		token: FIRST_POD_UID,
		guestBootId: FIRST_BOOT_ID,
	})
	restoreDns = stubLoopbackDns(() => '127.0.0.1')
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function livePod(uid: string): Record<string, unknown> {
	return { metadata: { name: WORKSPACE_NAME, uid }, status: { phase: 'Running' } }
}

async function handleClusterRequest(req: RecordedRequest): Promise<FakeApiReply> {
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
		if (claimForbidden) return { status: 403, body: { message: 'forbidden' } }
		if (!req.path.endsWith(`workspace-${WORKSPACE_NAME}`)) {
			return { status: 404, body: { message: 'gone' } }
		}
		return {
			status: 200,
			body: { metadata: { name: `workspace-${WORKSPACE_NAME}`, uid: CLAIM_UID } },
		}
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		if (sandboxGetDelayMs > 0)
			await new Promise((resolve) => setTimeout(resolve, sandboxGetDelayMs))
		if (sandboxDeleted) return { status: 404, body: { message: 'gone' } }
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME, uid: sandboxUid },
				// The disk is on the SANDBOX's own spec, as the controller
				// stores it (`volumeClaimTemplates` is CEL-immutable there),
				// and that is where the claim NAMES are read from — not from
				// the template, which an adopted object need not match.
				spec: { operatingMode, volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates },
				status: {
					conditions: [readyCondition(operatingMode === 'Suspended' ? 'False' : 'True')],
					// Unchanged across every replacement: the Service outlives
					// the pod, which is the whole reason the dial keeps working
					// and only the token says anything moved.
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: SELECTOR,
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (operatingMode === 'Suspended') return { status: 200, body: { items: [] } }
		return { status: 200, body: { items: [livePod(livePodUid)] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (operatingMode === 'Suspended') return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod(livePodUid) }
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

async function openWorkspace(
	overrides: {
		onCancellationUnconfirmed?: (notice: KubernetesWorkspaceCancellationNotice) => void
	} = {},
): Promise<KubernetesWorkspace> {
	if (!server || !agent) throw new Error('fixtures not started')
	const { onCancellationUnconfirmed } = overrides
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort: agent.port,
			readyTimeoutMs: 4_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		},
		{
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			...(onCancellationUnconfirmed !== undefined ? { onCancellationUnconfirmed } : {}),
		},
	)
}

/** Replace the pod the way the controller does: new uid, new bind token. */
function replacePod(): void {
	livePodUid = SECOND_POD_UID
	agent?.setToken(SECOND_POD_UID)
}

/**
 * Somebody else suspended the workspace: the object goes `Suspended`, the
 * controller takes the pod away, and this handle is told nothing.
 */
function suspendElsewhere(): void {
	operatingMode = 'Suspended'
	agent?.setUnreachable(true)
}

function sandboxReads(): number {
	return server?.matching('GET', `/sandboxes/${WORKSPACE_NAME}`).length ?? 0
}

/** Collect every guest restart a handle reports. */
function watch(workspace: KubernetesWorkspace): KubernetesGuestRestart[] {
	const events: KubernetesGuestRestart[] = []
	workspace.onGuestRestart((event) => events.push(event))
	return events
}

/** Resolve once the guest has parsed a request with this `op` AFTER `from`. */
async function waitForRequest(op: string, from: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (agent?.requests.slice(from).some((request) => request.op === op)) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(`the scripted agent never received a ${op} request`)
}

describe('what a handle reports it is bound to', () => {
	it('names the Sandbox, its disk, its pod and its agent process', async () => {
		const workspace = await openWorkspace()

		expect(workspace.identity).toEqual({
			sandboxUid: SANDBOX_UID,
			// Keyed by the volumeClaimTemplates entry NAME, read from the PVC
			// the controller derives from it (`<entry>-<sandbox name>`).
			volumeClaimUids: { workspace: CLAIM_UID },
			podUid: FIRST_POD_UID,
			guestBootId: FIRST_BOOT_ID,
		})
		expect(workspace.origin).toBe('created')
	}, 20_000)

	it('reads each PVC once, by name, and never lists them', async () => {
		await openWorkspace()
		if (!server) throw new Error('fixtures not started')

		const claims = server.matching('GET', '/persistentvolumeclaims')
		expect(claims).toHaveLength(1)
		expect(claims[0]?.path).toContain(`persistentvolumeclaims/workspace-${WORKSPACE_NAME}`)
		expect(server.requests.some((r) => r.path.includes('persistentvolumeclaims?'))).toBe(false)
	}, 20_000)

	it('works against a Role that cannot read PVCs, leaving the uids out', async () => {
		// The upgrade path: this release adds `get` on persistentvolumeclaims
		// to the shipped Role, and no Role from an earlier release has it. A
		// 403 must cost a deployment this one optional field and nothing else.
		claimForbidden = true
		const workspace = await openWorkspace()

		expect(workspace.identity.volumeClaimUids).toEqual({})
		expect(workspace.identity.sandboxUid).toBe(SANDBOX_UID)
		expect((await workspace.exec('true')).exitCode).toBe(0)
	}, 20_000)

	it('reports no pod and no agent process while suspended', async () => {
		const workspace = await openWorkspace()
		await workspace.suspend()

		// The ids it HAD would be the most misleading thing it could say: the
		// pod is deleted and they name nothing.
		expect(workspace.identity.podUid).toBeUndefined()
		expect(workspace.identity.guestBootId).toBeUndefined()
		// The disk is still there, and still the same disk.
		expect(workspace.identity.sandboxUid).toBe(SANDBOX_UID)
		expect(workspace.identity.volumeClaimUids).toEqual({ workspace: CLAIM_UID })
	}, 20_000)

	it('reports an undefined boot id against a guest that predates the field', async () => {
		// Interop, in the direction that matters most: an image built before
		// `guest-boot-id` existed answers exactly as it always did, and the
		// host reports "this guest cannot tell me" rather than "it changed".
		await agent?.close()
		agent = await startScriptedAgent({ host: '0.0.0.0', token: FIRST_POD_UID })
		const workspace = await openWorkspace()
		const events = watch(workspace)

		expect(workspace.identity.guestBootId).toBeUndefined()
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(workspace.identity.podUid).toBe(FIRST_POD_UID)
		expect(events).toEqual([])
	}, 20_000)
})

describe('following a pod the controller replaced', () => {
	it('rebinds an exec, announces it, and retries the refused call once', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)
		replacePod()
		agent?.setGuestBootId(SECOND_BOOT_ID)

		// The call the OLD token would have been refused for.
		expect((await workspace.exec('true')).exitCode).toBe(0)

		expect(events).toHaveLength(1)
		expect(events[0]?.reason).toBe('pod-replaced')
		expect(events[0]?.previous.podUid).toBe(FIRST_POD_UID)
		expect(events[0]?.current.podUid).toBe(SECOND_POD_UID)
		// The disk did not move, and the event says so as loudly as it says
		// the pod did.
		expect(events[0]?.previous.sandboxUid).toBe(SANDBOX_UID)
		expect(events[0]?.current.sandboxUid).toBe(SANDBOX_UID)
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
		// And nothing was written to the cluster to achieve any of it.
		expect(server?.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)
	}, 20_000)

	it('rebinds a writeFile, a readFile, a terminal and a tcp connection too', async () => {
		// The four that used to reject with a bare `Error('unauthorized')`
		// rather than a named class — the shapes a host could not hang a
		// recovery off, and the reason "unify the two shapes" is part of this
		// change rather than a tidy-up. Each is driven through the rebind
		// itself, not only through the refusal it ends with when no rebind is
		// possible: they take four different routes through the transport.
		for (const call of ['writeFile', 'readFile', 'openTerminal', 'openTcpConnection'] as const) {
			livePodUid = FIRST_POD_UID
			agent?.setToken(FIRST_POD_UID)
			const workspace = await openWorkspace()
			const events = watch(workspace)
			replacePod()

			if (call === 'writeFile') await workspace.writeFile('/workspace/f.txt', 'bytes')
			// The scripted guest answers every `read-file` with an empty
			// file; what is under test is that the call got an ANSWER from
			// the replacement rather than its refusal.
			if (call === 'readFile') {
				expect((await workspace.readFile('/workspace/f.txt')).length, call).toBe(0)
			}
			if (call === 'openTerminal') {
				const terminal = await workspace.openTerminal({ size: { cols: 80, rows: 24 } })
				terminal.kill('SIGKILL')
			}
			if (call === 'openTcpConnection') {
				const connection = await workspace.openTcpConnection({ port: 8080 })
				connection.destroy()
			}

			expect(
				events.map((event) => event.reason),
				call,
			).toEqual(['pod-replaced'])
			expect(workspace.identity.podUid, call).toBe(SECOND_POD_UID)
		}
	}, 40_000)

	it('shares one re-read between every call the replacement refused at once', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)
		replacePod()
		if (!server) throw new Error('fixtures not started')
		const before = sandboxReads()
		// Held long enough that every refusal in the burst arrives while the
		// first re-read is still in flight — which is what a real pod
		// replacement does to a busy handle, and what one re-read PER refused
		// call would turn into a burst of API traffic and a race to install
		// the winning handle.
		sandboxGetDelayMs = 50

		const results = await Promise.all([
			workspace.exec('true'),
			workspace.exec('true'),
			workspace.exec('true'),
		])

		expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0])
		expect(sandboxReads()).toBe(before + 1)
		expect(events).toHaveLength(1)
	}, 20_000)

	it('retries a refusal that lands after another call already rebound', async () => {
		// The other half of sharing one re-read. Nothing says a refusal
		// arrives before the re-read it would have triggered finishes: a
		// guest that takes longer to refuse than two API GETs take leaves a
		// call holding a refusal from the pod it was DISPATCHED on, against a
		// handle that has already followed the replacement. Re-reading there
		// would compare the new token against itself, conclude that nothing
		// moved, and fail a call the handle can now serve.
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		const events = watch(workspace)
		replacePod()
		const before = sandboxReads()

		// The slow call leaves first and is refused last.
		agent.setUnauthorizedDelayMs(800)
		const slow = workspace.writeFile('/workspace/slow.txt', 'bytes')
		await new Promise((resolve) => setTimeout(resolve, 100))
		// The quick one is refused at once, rebinds, and installs the
		// replacement's token while the slow one is still waiting.
		agent.setUnauthorizedDelayMs(0)
		expect((await workspace.exec('true')).exitCode).toBe(0)

		await expect(slow).resolves.toBeUndefined()

		// One re-read for both, and one event: the second call asked the
		// handle, not the API server.
		expect(sandboxReads()).toBe(before + 1)
		expect(events).toHaveLength(1)
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
	}, 20_000)

	it('ignores an answer from the pod it has already left', async () => {
		// The other direction of the same overlap. A rebind closes no socket
		// and does not retire the SESSION — only a suspend and a resume do —
		// so a call the OUTGOING pod accepted and is still working on gets
		// answered BY it, on the wire this handle has left, after another
		// call has followed the replacement. That answer carries the departed
		// pod's agent process, and read as this session's it moves the
		// handle's boot id onto the replacement: either it seeds the new
		// pod's baseline with a process that never ran there and the next
		// real reply announces a restart nobody had, or — the order this
		// fixture produces — it is itself announced as a
		// `container-restarted` whose two halves come from two different
		// pods. Both leave `workspace.identity` pairing the new pod's uid
		// with the old pod's process.
		const workspace = await openWorkspace()
		if (!agent) throw new Error('fixtures not started')
		const events = watch(workspace)
		const settled: string[] = []
		const before = agent.requests.length

		// Accepted by the FIRST pod, with the FIRST boot id on it, and
		// answered half a second later — a body that takes real time, or a
		// pod still inside its termination grace period.
		agent.setReplyDelayMs(500)
		const slow = workspace.writeFile('/workspace/slow.txt', 'bytes').then(() => {
			settled.push('write')
		})
		await waitForRequest('write-file', before)
		// From here on this is the REPLACEMENT: new uid, new bind token, new
		// agent process. The write already in flight is not.
		agent.setReplyDelayMs(0)
		replacePod()
		agent.setGuestBootId(SECOND_BOOT_ID)

		expect((await workspace.exec('true')).exitCode).toBe(0)
		settled.push('exec')
		await slow

		// The interleaving this case is about, asserted rather than hoped
		// for: the rebind and the retry it answered are both done before the
		// old pod's answer lands.
		expect(settled).toEqual(['exec', 'write'])
		// One move, and the one that happened.
		expect(events.map((event) => event.reason)).toEqual(['pod-replaced'])
		// Both halves are the replacement's own. The boot id the departed pod
		// reported names no process in this pod.
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
		expect(workspace.identity.guestBootId).toBe(SECOND_BOOT_ID)
	}, 20_000)

	it('leaves the original refusal standing when the pod did not move', async () => {
		// A guest that refuses a token for some other reason is not a pod
		// replacement, and must not be reported as one — nor rebound to, since
		// there is nothing to rebind to.
		const workspace = await openWorkspace()
		const events = watch(workspace)
		agent?.setToken('somebody-elses-pod')

		const failure = await workspace.exec('true').catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAgentUnauthorizedError)
		expect(events).toEqual([])
		expect(workspace.identity.podUid).toBe(FIRST_POD_UID)
		expect(workspace.suspended).toBe(false)
	}, 20_000)

	it('gives every operation the same named refusal when no rebind is possible', async () => {
		// One shape for all of them: `writeFile`, `readFile`, `openTerminal`
		// and `openTcpConnection` used to end with a bare `Error` whose whole
		// message was `unauthorized`.
		const workspace = await openWorkspace()
		agent?.setToken('somebody-elses-pod')

		const failures = await Promise.all([
			workspace.writeFile('/workspace/f.txt', 'bytes').catch((err: unknown) => err),
			workspace.readFile('/workspace/f.txt').catch((err: unknown) => err),
			workspace.openTerminal({ size: { cols: 80, rows: 24 } }).catch((err: unknown) => err),
			workspace.openTcpConnection({ port: 8080 }).catch((err: unknown) => err),
		])

		for (const failure of failures) {
			expect(failure).toBeInstanceOf(KubernetesAgentUnauthorizedError)
		}
	}, 20_000)
})

describe('refusing a workspace that is not the one this handle opened', () => {
	it('never rebinds to a Sandbox standing under the name with a different uid', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)
		// Deleted and recreated under the deterministic name: same name, new
		// object, EMPTY disk. The pod is new too, so the guest refuses.
		sandboxUid = OTHER_SANDBOX_UID
		replacePod()

		const failure = await workspace.exec('true').catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect((failure as KubernetesWorkspaceReplacedError).expectedSandboxUid).toBe(SANDBOX_UID)
		expect((failure as KubernetesWorkspaceReplacedError).actualSandboxUid).toBe(OTHER_SANDBOX_UID)
		expect(events).toEqual([])
		// Not followed, and nothing read about its pod: the refusal happens on
		// the uid, before anything is bound.
		expect(workspace.identity.podUid).toBe(FIRST_POD_UID)
	}, 20_000)

	it('names the deletion when no Sandbox stands under the name at all', async () => {
		const workspace = await openWorkspace()
		sandboxDeleted = true
		replacePod()

		const failure = await workspace.exec('true').catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect((failure as KubernetesWorkspaceReplacedError).actualSandboxUid).toBeUndefined()
		expect((failure as Error).message).toMatch(/no longer exists/)
	}, 20_000)
})

describe('a container the kubelet restarted in place', () => {
	it('announces it although the pod, the uid and the token never moved', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)
		// Same pod, same uid, same bind token: every call keeps working and
		// the Kubernetes API reports nothing at all.
		agent?.setGuestBootId(SECOND_BOOT_ID)

		expect((await workspace.exec('true')).exitCode).toBe(0)

		expect(events).toHaveLength(1)
		expect(events[0]?.reason).toBe('container-restarted')
		expect(events[0]?.previous.podUid).toBe(FIRST_POD_UID)
		expect(events[0]?.current.podUid).toBe(FIRST_POD_UID)
		expect(events[0]?.previous.guestBootId).toBe(FIRST_BOOT_ID)
		expect(events[0]?.current.guestBootId).toBe(SECOND_BOOT_ID)
		expect(workspace.identity.guestBootId).toBe(SECOND_BOOT_ID)
	}, 20_000)

	it('announces it once, not on every later reply', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)
		agent?.setGuestBootId(SECOND_BOOT_ID)

		await workspace.exec('true')
		await workspace.exec('true')
		await workspace.writeFile('/workspace/f.txt', 'bytes')

		expect(events).toHaveLength(1)
	}, 20_000)
})

describe("the caller's own suspend and resume", () => {
	it('changes the pod, keeps the disk, and announces nothing', async () => {
		const workspace = await openWorkspace()
		const events = watch(workspace)

		await workspace.suspend()
		replacePod()
		agent?.setGuestBootId(SECOND_BOOT_ID)
		await workspace.resume()

		// The pod change was ASKED for, and a host that issued it already
		// knows its processes are gone. Announcing it would train callers to
		// ignore the event that matters.
		expect(events).toEqual([])
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
		expect(workspace.identity.guestBootId).toBe(SECOND_BOOT_ID)
		expect(workspace.identity.sandboxUid).toBe(SANDBOX_UID)
		expect(workspace.identity.volumeClaimUids).toEqual({ workspace: CLAIM_UID })
	}, 20_000)

	it('stops announcing once a listener unsubscribes', async () => {
		const workspace = await openWorkspace()
		const events: KubernetesGuestRestart[] = []
		const unsubscribe = workspace.onGuestRestart((event) => events.push(event))
		unsubscribe()
		agent?.setGuestBootId(SECOND_BOOT_ID)

		await workspace.exec('true')

		expect(events).toEqual([])
	}, 20_000)
})

describe('a command whose cancellation could not be confirmed', () => {
	it('names the replaced pod, keeps the workspace Running and patches nothing', async () => {
		// The critic's case (a): an `exec` is in flight, the pod is deleted,
		// and the controller brings up a replacement. The command's outcome is
		// unknowable — nothing on this side ever saw it end — and the pod it
		// ran in is gone, so a Suspended patch could not stop it and would
		// only take the REPLACEMENT away from every other holder.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setExecuteHangs(true)
		const sentBefore = agent.requests.length
		const running = workspace.exec('sleep', ['120']).catch((err: unknown) => err)
		await waitForRequest('execute', sentBefore)
		// The pod goes: the connection dies with it and the replacement comes
		// up under the same name with a new uid.
		agent.setUnreachable(true)
		replacePod()

		const failure = await running

		expect(failure).toBeInstanceOf(KubernetesWorkspaceGuestGoneError)
		expect((failure as KubernetesWorkspaceGuestGoneError).evidence).toBe('pod-replaced')
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.podUid).toBe(FIRST_POD_UID)
		expect((failure as KubernetesWorkspaceGuestGoneError).current.podUid).toBe(SECOND_POD_UID)
		// The identity halves are pinned, not just the pod uids: `previous`
		// is the guest the COMMAND reserved on, and `current` names NO agent
		// process, because nothing has heard a word from the replacement. A
		// boot id here would name a process that pod never ran.
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.guestBootId).toBe(FIRST_BOOT_ID)
		expect((failure as KubernetesWorkspaceGuestGoneError).current.guestBootId).toBeUndefined()
		expect((failure as Error).message).toContain(`agent ${FIRST_BOOT_ID} → nothing has answered`)
		expect((failure as Error).message).toMatch(/outcome is UNKNOWN/)
		// The rule the base class states is unchanged, and so is the class a
		// host already catches.
		expect(failure).toMatchObject({ retirement: { accepted: false, reason: 'workspace-kept' } })
		expect(notices).toHaveLength(1)
		expect(notices[0]?.guest).toBe('pod-replaced')

		// Not one write of any kind, and the workspace is exactly where it was.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)

		// And the next call simply binds the replacement.
		agent.setUnreachable(false)
		agent.setExecuteHangs(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
	}, 40_000)

	it('names a pod replacement as one even when the handle has since heard a new boot id', async () => {
		// The trap a free piece of evidence sets. A changed boot id is the
		// ONLY thing that can see a container restarted in place — and on its
		// own it cannot tell that from a pod ANOTHER call has already rebound
		// to, because both leave the handle talking to a process this command
		// never reserved against. Consulted before the pod read, it called a
		// pod replacement a restart in place: an answer that tells a host the
		// address and the token still work when neither of them does.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setExecuteHangs(true)
		const sentBefore = agent.requests.length
		const running = workspace.exec('sleep', ['120']).catch((err: unknown) => err)
		await waitForRequest('execute', sentBefore)
		// A NEW pod, running a NEW agent process.
		agent.setUnreachable(true)
		replacePod()
		agent.setGuestBootId(SECOND_BOOT_ID)
		agent.setExecuteHangs(false)
		agent.setUnreachable(false)
		// Another call follows it, so by the time the in-flight command gives
		// up on its cancellation the handle's own boot id is the
		// replacement's — which is exactly what a handle-read baseline would
		// mistake for a restart in place.
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(workspace.identity.guestBootId).toBe(SECOND_BOOT_ID)

		const failure = await running

		expect(failure).toBeInstanceOf(KubernetesWorkspaceGuestGoneError)
		expect((failure as KubernetesWorkspaceGuestGoneError).evidence).toBe('pod-replaced')
		// And `previous` is the command's own guest, not the handle's: the
		// rebind moved the handle while this command was failing, and naming
		// the REPLACEMENT as the pod that died would be exactly backwards.
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.podUid).toBe(FIRST_POD_UID)
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.guestBootId).toBe(FIRST_BOOT_ID)
		expect((failure as KubernetesWorkspaceGuestGoneError).current.podUid).toBe(SECOND_POD_UID)
		// A boot id on `current` is allowed here, and only here of the three
		// non-same-guest verdicts: this handle really has heard from the
		// replacement's agent.
		expect((failure as KubernetesWorkspaceGuestGoneError).current.guestBootId).toBe(SECOND_BOOT_ID)
		expect(notices).toHaveLength(1)
		expect(notices[0]?.guest).toBe('pod-replaced')
		expect(workspace.suspended).toBe(false)
	}, 40_000)

	it('names the restarted container, keeps the workspace Running and patches nothing', async () => {
		// The critic's case (b): the agent process is restarted inside the
		// same pod with an `exec` in flight. The pod uid and the token never
		// move, so no API read can see it — the changed boot id on the
		// `cancel-execution` refusal is the only evidence there is.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setExecuteHangs(true)
		const sentBefore = agent.requests.length
		const running = workspace.exec('sleep', ['120']).catch((err: unknown) => err)
		await waitForRequest('execute', sentBefore)
		// The container dies, taking the connection with it, and comes back as
		// a NEW agent process that knows nothing of this execution.
		agent.setUnreachable(true)
		agent.setGuestBootId(SECOND_BOOT_ID)
		agent.setForgetsExecutions(true)
		agent.setExecuteHangs(false)
		agent.setUnreachable(false)

		const failure = await running

		expect(failure).toBeInstanceOf(KubernetesWorkspaceGuestGoneError)
		expect((failure as KubernetesWorkspaceGuestGoneError).evidence).toBe('container-restarted')
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.podUid).toBe(FIRST_POD_UID)
		expect((failure as KubernetesWorkspaceGuestGoneError).current.podUid).toBe(FIRST_POD_UID)
		// The whole of the evidence is in these two, and the message that
		// says "a different agent process" has to print two different values
		// or it contradicts itself: the process the command RESERVED on, and
		// the one answering from that same pod now.
		expect((failure as KubernetesWorkspaceGuestGoneError).previous.guestBootId).toBe(FIRST_BOOT_ID)
		expect((failure as KubernetesWorkspaceGuestGoneError).current.guestBootId).toBe(SECOND_BOOT_ID)
		expect((failure as Error).message).toContain(`agent ${FIRST_BOOT_ID} → ${SECOND_BOOT_ID}`)
		expect(notices).toHaveLength(1)
		expect(notices[0]?.guest).toBe('container-restarted')

		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).not.toBe('destroyed')
	}, 40_000)

	it('does not blame a restart the handle already survived on a later command', async () => {
		// The regression: the baseline is per EXECUTION, not per session. A
		// container that restarted an hour ago says nothing about a command
		// started after it, and a handle-wide baseline would answer
		// `container-restarted` for every unconfirmed cancellation for the
		// rest of the session — telling a host with certainty that a command
		// which is very likely still running is gone.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!agent) throw new Error('fixtures not started')
		const events = watch(workspace)
		// The restart happens, is announced, and the handle carries on.
		agent.setGuestBootId(SECOND_BOOT_ID)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(events).toHaveLength(1)

		// A LATER command, started in the guest that is running now, loses its
		// cancellation.
		agent.setLosingExecutions(true)
		const failure = await workspace.exec('sleep', ['30']).catch((err: unknown) => err)

		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceGuestGoneError)
		expect(notices).toHaveLength(1)
		expect(notices[0]?.guest).toBe('same-guest')
		expect(workspace.suspended).toBe(false)
		// And nothing new was announced: the guest never moved again.
		expect(events).toHaveLength(1)
	}, 40_000)

	it('names a foreign suspend as a suspend, and leaves the handle resumable', async () => {
		// A suspended workspace has no pod, so the diagnosis is the same
		// "the guest is gone" it is for a deleted one — but only one of the
		// two answers lets the caller recover. #473 promises that a suspend
		// somebody else issued arrives as `KubernetesWorkspaceSuspendedError`
		// and that the handle adopts it, so `resume()` brings a pod back.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setExecuteHangs(true)
		const sentBefore = agent.requests.length
		const running = workspace.exec('sleep', ['120']).catch((err: unknown) => err)
		await waitForRequest('execute', sentBefore)
		suspendElsewhere()

		const failure = await running

		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect((failure as KubernetesWorkspaceSuspendedError).noticedBy).toBe('transport')
		expect(workspace.suspended).toBe(true)
		// The evidence still reaches the host's callback — it is accurate,
		// there really is no pod — but it is not what names the error.
		expect(notices).toHaveLength(1)
		expect(notices[0]?.guest).toBe('pod-gone')
		// And it is accurate in both halves: the command's own guest on one
		// side, nothing at all on the other. A suspended workspace has no pod
		// and therefore no agent process, so naming one here would be the
		// single most misleading thing this notice could say.
		expect(notices[0]?.previous.podUid).toBe(FIRST_POD_UID)
		expect(notices[0]?.previous.guestBootId).toBe(FIRST_BOOT_ID)
		expect(notices[0]?.current.podUid).toBeUndefined()
		expect(notices[0]?.current.guestBootId).toBeUndefined()
		// This handle patched nothing: the suspend was somebody else's.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)

		// And the documented recovery really works, rather than returning
		// silently on a handle that still believes it is running.
		agent.setExecuteHangs(false)
		agent.setUnreachable(false)
		replacePod()
		await workspace.resume()

		expect(workspace.suspended).toBe(false)
		expect(workspace.identity.podUid).toBe(SECOND_POD_UID)
		expect((await workspace.exec('true')).exitCode).toBe(0)
	}, 40_000)

	it('leaves the old error alone when the guest is demonstrably the same one', async () => {
		// The pod is still there and the agent is still the same process: the
		// command really may still be running, and claiming its guest is gone
		// would be a lie that reads as reassurance.
		const workspace = await openWorkspace({ onCancellationUnconfirmed: () => undefined })
		if (!agent) throw new Error('fixtures not started')
		agent.setLosingExecutions(true)

		const failure = await workspace.exec('sleep', ['30']).catch((err: unknown) => err)

		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceGuestGoneError)
		expect((failure as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		expect(workspace.suspended).toBe(false)
	}, 40_000)
})
