/**
 * Suspend and resume, against a cluster that behaves the way a real one was
 * observed to: a resumed pod keeps the sandbox's NAME and gets a new uid and
 * a new IP, and for a while the outgoing pod is still listed beside it.
 *
 * That is the shape of the classic failure this suite exists to catch. A
 * handle that survives a suspend unchanged keeps working against a fake that
 * answers the same address with the same token forever, and fails only on a
 * real cluster, where the address moved and the token the agent will accept
 * changed underneath it. So the fixtures move both:
 *
 *  - the SAME Service FQDN resolves to `127.0.0.1` before the suspend and
 *    `127.0.0.2` after it, and the agent listens on both, recording which
 *    address each connection arrived on;
 *  - the agent binds to the old pod's uid before the suspend and the new
 *    pod's after it, so a handle presenting the stale token is refused by the
 *    guest rather than quietly accepted;
 *  - the terminating old pod is returned by the pod GET **and** listed beside
 *    the new one, so a reader that takes the first uid it sees takes the
 *    wrong one. That pair is a deliberate worst case rather than a recorded
 *    cluster moment: two pods cannot hold one name in one namespace, so on a
 *    real cluster the outgoing pod answers the GET until it is fully gone and
 *    the replacement is created after. Each reading is its own trap, and one
 *    fixture that presents both is cheaper than two that each present one.
 *
 * And the mirror image on the way out: the Sandbox's `Suspended` condition is
 * left True after a resume, exactly as upstream documents, and the pod drains
 * slowly. A suspend that believed either the condition or a `deletionTimestamp`
 * would resolve while the guest was still writing to the disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point rather than the backend-local one:
// the public `createKubernetesWorkspace` is the surface a host calls, and it
// maps the exported config shape onto the backend's own.
import { createKubernetesWorkspace } from '../../../index.js'
import { KubernetesAgentRetiringError } from '../transport.js'
import type { KubernetesWorkspace } from '../workspace.js'
import {
	type KubernetesWorkspaceCancellationNotice,
	KubernetesWorkspaceSuspendTimeoutError,
	KubernetesWorkspaceSuspendedError,
} from '../workspace.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	operatingModePatchBody,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'long-lived'
const WORKSPACE_NAME = 'namzu-ws-long-lived'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=llv'
/** The pod before the suspend, and the pod after it. Different uids. */
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const FIRST_ADDRESS = '127.0.0.1'
const SECOND_ADDRESS = '127.0.0.2'

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

type Phase = 'first' | 'suspended' | 'resumed'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
let phase: Phase
let dnsAddress: string
/**
 * Upstream: "the controller does not currently remove this condition when the
 * Sandbox is resumed, so a stale Suspended condition may linger after
 * operatingMode returns to Running."
 */
let staleSuspendedCondition: boolean
/** Pod GETs answered with a still-draining pod before the pod finally 404s. */
let drainingPodGets: number
/**
 * Suspend PATCHes the API server refuses with a 500 before accepting one.
 * A merge patch that is rejected changes nothing at all, so `phase` does not
 * move either — which is the state the handle has to agree with.
 */
let refusedSuspendPatches: number
/**
 * Pod reads after a resume that answer with the PRE-SUSPEND pod, looking
 * perfectly live: no `deletionTimestamp`, phase `Running`, old uid. The
 * controller has not replaced the pod yet and the Ready condition never went
 * False, so nothing in the Sandbox's status says to wait.
 */
let stalePodReads: number
/**
 * Pod LIST answers after a resume that hold no live pod at all: the pod the
 * suspend patch retired is still draining and the controller has not created
 * its replacement yet. `readBoundPod` answers that shape by THROWING
 * rather than returning undefined, and it is the only shape a resume issued
 * straight after a suspend whose pod outlived its wait ever sees at first.
 */
let podlessReads: number

beforeEach(async () => {
	phase = 'first'
	dnsAddress = FIRST_ADDRESS
	staleSuspendedCondition = false
	drainingPodGets = 0
	refusedSuspendPatches = 0
	stalePodReads = 0
	podlessReads = 0
	// One server on every loopback address, so `localAddress` on an accepted
	// connection is the address the CLIENT aimed at.
	agent = await startScriptedAgent({ host: '0.0.0.0', token: FIRST_POD_UID })
	restoreDns = stubLoopbackDns(() => dnsAddress)
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

/** The pod that is on its way out: same name, old uid, a deletionTimestamp. */
function terminatingPod(uid: string): Record<string, unknown> {
	return {
		metadata: {
			name: WORKSPACE_NAME,
			uid,
			deletionTimestamp: '2026-09-16T00:00:01Z',
		},
		status: { phase: 'Running' },
	}
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const mode = (req.body as { spec?: { operatingMode?: string } }).spec?.operatingMode
		if (mode === 'Suspended' && refusedSuspendPatches > 0) {
			refusedSuspendPatches -= 1
			return { status: 500, body: { message: 'etcdserver: request timed out' } }
		}
		phase = mode === 'Suspended' ? 'suspended' : 'resumed'
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME },
				spec: { operatingMode: phase === 'suspended' ? 'Suspended' : 'Running' },
				status: {
					conditions: [
						readyCondition(phase === 'suspended' ? 'False' : 'True'),
						...(phase === 'suspended' || staleSuspendedCondition
							? [
									{
										type: 'Suspended',
										status: 'True',
										// Upstream's Suspended=True reason. (`SandboxSuspended`
										// is the Ready=False one — a fixture carrying it would
										// read as cluster-faithful while being wrong.)
										reason: 'PodTerminated',
										message: 'pod terminated',
										lastTransitionTime: '2026-09-16T00:00:00Z',
									},
								]
							: []),
					],
					podIPs: [phase === 'resumed' ? '10.244.0.7' : '10.244.0.6'],
					// The address the handle re-resolves. It does not change —
					// the pod behind it does, which is exactly the point.
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: SELECTOR,
				},
			},
		}
	}
	// Checked before `/pods/`: the list path is `/pods?labelSelector=…`.
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		// For as long as `podlessReads` stands there is nothing live to find:
		// the outgoing pod is draining and its replacement is not created yet.
		if (podlessReads > 0) {
			podlessReads -= 1
			return { status: 200, body: { items: [terminatingPod(FIRST_POD_UID)] } }
		}
		// The terminating pod first: a reader that takes the first uid in the
		// list binds to the one that is leaving. (Worst case on purpose — see
		// the file comment on why a cluster shows one at a time.)
		return {
			status: 200,
			body: { items: [terminatingPod(FIRST_POD_UID), livePod(SECOND_POD_UID)] },
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (phase === 'first') return { status: 200, body: livePod(FIRST_POD_UID) }
		if (phase === 'suspended') {
			// The pod does not vanish when the patch is accepted. While it
			// drains it is still there, still phase Running, carrying only a
			// deletionTimestamp — and still writing to the block device.
			if (drainingPodGets > 0) {
				drainingPodGets -= 1
				return { status: 200, body: terminatingPod(SECOND_POD_UID) }
			}
			return { status: 404, body: { message: 'gone' } }
		}
		// Resumed, and the controller has not got to the pod yet: the OLD pod
		// is still there under the same name, not yet marked for deletion.
		// Nothing about this answer says "wait" except its uid.
		if (stalePodReads > 0) {
			stalePodReads -= 1
			return { status: 200, body: livePod(FIRST_POD_UID) }
		}
		// Resumed: the pod name is unchanged, so this still answers with the
		// OUTGOING pod until it finishes terminating.
		return { status: 200, body: terminatingPod(FIRST_POD_UID) }
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

async function openWorkspace(
	overrides: {
		readyTimeoutMs?: number
		onCancellationUnconfirmed?: (notice: KubernetesWorkspaceCancellationNotice) => void
	} = {},
) {
	if (!server || !agent) throw new Error('fixtures not started')
	const { onCancellationUnconfirmed, ...backend } = overrides
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort: agent.port,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
			...backend,
		},
		{
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			...(onCancellationUnconfirmed !== undefined ? { onCancellationUnconfirmed } : {}),
		},
	)
}

/**
 * Resolve once the guest has parsed a request with this `op` AFTER `from`.
 *
 * Polled rather than awaited on a hook, because what a case needs to know is
 * that the agent RECEIVED the request — the point after which breaking the
 * connection breaks a command that is already admitted rather than one that
 * was never sent.
 *
 * `from` is not optional, and that is deliberate: the acquire-time privilege
 * probe is itself an `execute`, so a search over the whole log answers "yes"
 * before the case has sent anything, and every case built on this would flip
 * its switch too early and prove nothing.
 */
async function waitForRequest(op: string, from: number, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (agent?.requests.slice(from).some((request) => request.op === op)) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(`the scripted agent never received a ${op} request`)
}

/** Every token the guest has seen in a request envelope, in order. */
function presentedTokens(): string[] {
	if (!agent) throw new Error('fixtures not started')
	return agent.requests
		.map((request) => request.token)
		.filter((token): token is string => typeof token === 'string')
}

describe('suspend', () => {
	it('sends exactly the operatingMode patch and nothing else', async () => {
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		await workspace.suspend()

		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.path).toContain(`/sandboxes/${WORKSPACE_NAME}`)
		// Deep equality, not a property check: a patch that also carried
		// `shutdownTime` or a podTemplate would change something nobody asked
		// to change, and a merge patch applies whatever it is given.
		expect(patches[0]?.body).toEqual(operatingModePatchBody('Suspended'))
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(true)
	})

	it('is idempotent', async () => {
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		await workspace.suspend()
		await workspace.suspend()
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1)
	})

	it('waits for the pod, not for the Suspended condition or a deletionTimestamp', async () => {
		// The condition cannot be the signal: upstream never clears it on a
		// resume, so from the second suspend onwards it reads True before the
		// patch is even sent. And a deletionTimestamp is not the signal either
		// — it appears the moment the DELETE is accepted, with the guest still
		// running and still writing to the block device the caller is being
		// promised is quiesced.
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')

		// Round one, so that there is a condition to go stale.
		await workspace.suspend()
		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		await workspace.resume()
		staleSuspendedCondition = true
		// Round two, against a guest that rides out three polls' worth of its
		// termination grace period.
		drainingPodGets = 3
		const podGetsBefore = server.matching('GET', '/pods/').length

		await workspace.suspend()

		expect(drainingPodGets).toBe(0)
		// Three drains and the 404 that ended it: the stale True bought the
		// wait nothing, and neither did the deletionTimestamp on each drain.
		expect(server.matching('GET', '/pods/').length - podGetsBefore).toBeGreaterThanOrEqual(4)
		expect(workspace.suspended).toBe(true)
	})

	it('does not record a suspend whose pod outlived the wait', async () => {
		const workspace = await openWorkspace({ readyTimeoutMs: 1_000 })
		if (!server) throw new Error('fixtures not started')
		// A guest whose PID 1 ignores SIGTERM for longer than the wait allows.
		drainingPodGets = Number.POSITIVE_INFINITY

		const failure = await workspace.suspend().catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendTimeoutError)
		// The operator is told which knob and which image behaviour to look at.
		expect((failure as Error).message).toMatch(/terminationGracePeriodSeconds/)
		expect((failure as Error).message).toMatch(/readyTimeoutMs/)
		// The patch landed, so the pod is going away and nothing is admitted:
		// refusing calls is the survivable direction.
		expect(workspace.suspended).toBe(true)
		await expect(workspace.exec('true')).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendedError)

		// And the suspend is NOT recorded as done. The next one patches and
		// waits again rather than returning on a wait this one lost — which is
		// the whole difference between a state marked on the way out and one
		// marked when the cluster confirmed it.
		const patchesBefore = server.matching('PATCH', '/sandboxes/').length
		drainingPodGets = 0
		await workspace.suspend()
		expect(server.matching('PATCH', '/sandboxes/').length).toBe(patchesBefore + 1)
		expect(workspace.suspended).toBe(true)
	})

	it('leaves the workspace running when the cluster refuses the patch', async () => {
		// The defect this guards: a handle that marks itself suspended before
		// the patch is sent answers every later suspend() and destroy() from
		// that mark, so a 500 is thrown once and the pod then runs — and bills
		// — behind a handle that says it is asleep.
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		refusedSuspendPatches = 1

		const failure = await workspace.suspend().catch((err: unknown) => err)
		expect((failure as Error).message).toMatch(/500/)
		// Nothing was asked of the cluster, so nothing changed here: the pod is
		// still running and this handle still serves it.
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).toBe('ready')
		expect((await workspace.exec('true')).exitCode).toBe(0)

		const patchesBefore = server.matching('PATCH', '/sandboxes/').length
		await workspace.suspend()
		expect(server.matching('PATCH', '/sandboxes/').length).toBe(patchesBefore + 1)
		expect(workspace.suspended).toBe(true)
	})

	it('shares one flight between concurrent suspend calls', async () => {
		// Deferring the mark until the cluster confirms opens a window the
		// serialisation queue does not close on its own: a second suspend()
		// admitted after the first finishes finds nothing marked and patches
		// all over again. A single flight is what closes it.
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		refusedSuspendPatches = 2

		const first = workspace.suspend().catch((err: unknown) => err)
		const second = workspace.suspend().catch((err: unknown) => err)
		const [a, b] = await Promise.all([first, second])

		expect(a).toBeInstanceOf(Error)
		// The same rejection object: one transition, awaited twice.
		expect(b).toBe(a)
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(1)
		// Only one of the two refusals was ever consumed.
		expect(refusedSuspendPatches).toBe(1)
		expect(workspace.suspended).toBe(false)
	})
})

describe('resume', () => {
	it('dials a different address and presents a different token', async () => {
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')

		// Everything before the suspend went to the first address with the
		// first pod's uid.
		expect(agent.connections.length).toBeGreaterThan(0)
		expect(new Set(agent.connections.map((c) => c.localAddress))).toEqual(new Set([FIRST_ADDRESS]))
		expect(new Set(presentedTokens())).toEqual(new Set([FIRST_POD_UID]))

		await workspace.suspend()
		const dialsWhileSuspended = agent.connections.length
		await expect(workspace.exec('true')).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect(agent.connections.length).toBe(dialsWhileSuspended)

		// The pod comes back somewhere else, as a fresh agent process that
		// will refuse anything but its own uid.
		const requestsBeforeResume = agent.requests.length
		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		await workspace.resume()

		const resumePatch = server.requests.filter((r) => r.method === 'PATCH').at(-1)
		expect(resumePatch?.body).toEqual(operatingModePatchBody('Running'))
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).toBe('ready')

		// The privilege probe runs again on resume, so the handle has already
		// been through the new agent by the time `resume()` resolves.
		const afterResume = agent.connections.slice(dialsWhileSuspended)
		expect(afterResume.length).toBeGreaterThan(0)
		expect(new Set(afterResume.map((c) => c.localAddress))).toEqual(new Set([SECOND_ADDRESS]))

		// And a real call goes through, which it could not if the handle were
		// still presenting the pre-suspend token: the guest is bound to the
		// new uid and answers `unauthorized` to anything else.
		const result = await workspace.exec('true')
		expect(result.exitCode).toBe(0)
		// Not one request after the resume carried the stale token.
		const tokensAfterResume = agent.requests
			.slice(requestsBeforeResume)
			.map((request) => request.token)
			.filter((token): token is string => typeof token === 'string')
		expect(tokensAfterResume.length).toBeGreaterThan(0)
		expect(new Set(tokensAfterResume)).toEqual(new Set([SECOND_POD_UID]))
	})

	it('skips the terminating pod that still answers to the sandbox name', async () => {
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		await workspace.suspend()
		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		await workspace.resume()

		// The GET by name answered with the outgoing pod, so the read had to
		// fall through to the selector list — and then pick the live pod out
		// of it rather than the first entry, which is the terminating one.
		expect(server.matching('GET', '/pods/').at(-1)?.path).toContain(WORKSPACE_NAME)
		expect(server.matching('GET', '/pods?')).toHaveLength(1)
		expect(server.matching('GET', '/pods?')[0]?.path).toContain(encodeURIComponent(SELECTOR))
		expect(presentedTokens().at(-1)).toBe(SECOND_POD_UID)
	})

	it('keeps reading the pod until the old uid is gone, not until Ready says so', async () => {
		// Ready is not a transition signal. The controller leaves the condition
		// True across a resume, so the first poll after the Running patch can
		// come back Ready while the only pod under that name is still the one
		// the workspace was suspended from — no deletionTimestamp, phase
		// Running, and a uid the new agent will refuse. A handle that read the
		// token once would bind it and fail later with a flat `unauthorized`.
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		await workspace.suspend()

		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		// Two polls' worth of a perfectly live old pod.
		stalePodReads = 2
		const requestsBeforeResume = agent.requests.length
		await workspace.resume()

		expect(stalePodReads).toBe(0)
		// It bound the new pod, not the one it kept being handed.
		const tokensAfterResume = agent.requests
			.slice(requestsBeforeResume)
			.map((request) => request.token)
			.filter((token): token is string => typeof token === 'string')
		expect(tokensAfterResume.length).toBeGreaterThan(0)
		expect(new Set(tokensAfterResume)).toEqual(new Set([SECOND_POD_UID]))
		expect((await workspace.exec('true')).exitCode).toBe(0)
	})

	it('waits out the drain of a suspend whose own wait ran out', async () => {
		// That suspend's patch LANDED — it only ran out of time watching the
		// pod go — so the controller is taking that pod away and the resume
		// behind it must still see it replaced. It arrives mid-drain, when
		// there is no live pod of the name at all and the uid read throws
		// instead of answering. Treating that as fatal would fail a resume
		// that the deadline already in hand would have carried, and put a
		// workspace back to sleep that was moments from being usable.
		const workspace = await openWorkspace({ readyTimeoutMs: 1_000 })
		if (!server || !agent) throw new Error('fixtures not started')
		drainingPodGets = Number.POSITIVE_INFINITY
		await expect(workspace.suspend()).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendTimeoutError)

		drainingPodGets = 0
		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		podlessReads = 2
		await workspace.resume()

		expect(podlessReads).toBe(0)
		expect(workspace.suspended).toBe(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		// The new pod's uid, never the one the timed-out suspend retired.
		expect(presentedTokens().at(-1)).toBe(SECOND_POD_UID)
	})

	it('is idempotent on a running workspace', async () => {
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		await workspace.resume()
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
	})

	it('refuses to resume a deleted workspace', async () => {
		const workspace = await openWorkspace()
		await workspace.destroy({ deleteDisk: true })
		await expect(workspace.resume()).rejects.toThrow(/has been destroyed/)
		await expect(workspace.suspend()).rejects.toThrow(/has been destroyed/)
	})
})

describe('a pod that stops being able to say what happened to a command', () => {
	it('keeps the pod: no patch, no delete, and the workspace goes on serving', async () => {
		// The defect this guards is the sharpest one on this path, because
		// nothing about it is visible from the call that triggers it. The
		// inner handle used to retire itself when an execution's cancellation
		// could not be confirmed, by calling the `release` it was built with —
		// and on a task sandbox that release is a DELETE, correctly, because
		// the object is disposable. Hand a workspace the same callback and a
		// wedged agent or a partitioned pod DELETEs a Sandbox whose PVC holds
		// every file the caller has, from inside a failing `exec()`, with
		// `deleteDisk` never passed by anyone. That was fixed by making the
		// workspace's release a SUSPEND patch instead — and the patch is the
		// same defect one size smaller: it makes the controller delete the
		// pod, so every other holder's terminals, dev servers and running
		// commands die because ONE command's cancellation went unanswered for
		// eight seconds. So now nothing at all is written. See #480.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		// An agent that admits the command, loses the connection under it, and
		// then cannot say what became of it — which is how the real agent
		// FENCES itself, so this one does too.
		agent.setLosingExecutions(true)

		const failure = await workspace.exec('sleep', ['30']).catch((err: unknown) => err)
		expect((failure as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		// Not accepted, and not a patch that failed either: nothing was
		// attempted, and the `reason` is what stops a host reading it as one.
		expect(failure).toMatchObject({
			retirement: { accepted: false, reason: 'workspace-kept' },
		})
		expect((failure as { retirement?: { error?: unknown } }).retirement?.error).toBeUndefined()

		// Not one write of any kind. That is the whole assertion.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)

		// What the host gets instead is the fact the error cannot carry: this
		// agent ANSWERED, and what it answered is that it has fenced itself.
		expect(notices).toHaveLength(1)
		expect(notices[0]?.agent).toBe('retiring')
		expect(notices[0]?.error).toBe(failure)

		// And the workspace is exactly where it was: Running, not suspended,
		// still admitting calls.
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).not.toBe('destroyed')
	}, 20_000)

	it('names the fenced agent on the next call instead of a wire-shape error', async () => {
		// A fenced agent refuses every op but `healthz` and `cancel-execution`
		// with `agent_retiring`. Unmapped, the reserve that meets it is parsed
		// as a reservation and rejected as "an invalid execution reservation"
		// — a message about a wire shape, for a pod telling the truth about
		// itself, handed to a SECOND holder that did nothing wrong.
		const workspace = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setLosingExecutions(true)
		await workspace.exec('sleep', ['30']).catch(() => undefined)
		agent.setLosingExecutions(false)

		const refused = await workspace.exec('true').catch((err: unknown) => err)

		expect(refused).toBeInstanceOf(KubernetesAgentRetiringError)
		expect((refused as Error).message).not.toMatch(/invalid execution reservation/)
		// It says what actually fixes it, in the order it has to be done.
		expect((refused as Error).message).toMatch(/suspend\(\).*resume\(\)/)
		// And it does not promise what it cannot: the fence is the guest's and
		// `dispatch` gates it ahead of read-file, write-file, terminal and
		// tcp-connect, so telling a host "this handle still works for every
		// other call" would send it round a loop of identical refusals. What
		// was left alone is the CLUSTER and this handle's retirement, which is
		// a different claim.
		expect((refused as Error).message).toMatch(/every call except healthz and cancel-execution/)
		expect((refused as Error).message).not.toMatch(/works for every other call/)
		await expect(workspace.readFile('/workspace/anything')).rejects.toThrow()
		// And it did not retire the handle: the workspace still admits calls,
		// still reports itself running, and still wrote nothing.
		expect(workspace.suspended).toBe(false)
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)

		// The cure is the one the error names, and it is the HOST's to choose:
		// it takes the live terminals in that pod down with it.
		dnsAddress = SECOND_ADDRESS
		agent.setToken(SECOND_POD_UID)
		await workspace.suspend()
		await workspace.resume()

		expect(workspace.suspended).toBe(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(presentedTokens().at(-1)).toBe(SECOND_POD_UID)
	}, 30_000)

	it('reports an agent it could not reach at all, and keeps the workspace', async () => {
		// The other outcome, and the one the old `healthz()` boolean could not
		// tell from the first: every cancel attempt fails to CONNECT for the
		// whole window. Nothing can be concluded about the command, and
		// nothing should be concluded about the workspace either — the pod may
		// be perfectly fine a second from now, and suspending it would be a
		// network blip deleting a pod.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		// The command is ADMITTED first and the network goes afterwards,
		// which is the order that matters: a reserve that never connected
		// fails as a reserve, and this case is about a command that was
		// already running when the host stopped being able to hear about it.
		agent.setExecuteHangs(true)
		const sentBefore = agent.requests.length
		const running = workspace.exec('sleep', ['30']).catch((err: unknown) => err)
		await waitForRequest('execute', sentBefore)
		agent.setUnreachable(true)

		const failure = await running
		expect((failure as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		expect(failure).toMatchObject({
			retirement: { accepted: false, reason: 'workspace-kept' },
		})
		expect(notices).toHaveLength(1)
		expect(notices[0]?.agent).toBe('unreachable')

		// Nothing written, and the handle still believes what is true.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)

		// And when the pod answers again the workspace is simply usable. No
		// resume, no new pod, no probe: nothing was taken away.
		agent.setUnreachable(false)
		agent.setExecuteHangs(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
	}, 30_000)

	it("does not read a busy agent's named refusal as a fence", async () => {
		// The third answer, and the one the classification used to get wrong.
		// A `healthz` that never reaches `dispatch` — refused by the agent's
		// connection gate because too many unauthenticated connections are
		// already open — comes back `{ ok: false }` with a reason of its own
		// and NO `retiring` flag. Reading any not-`ok` reply as a fence told
		// the host `agent: 'retiring'`, whose documented cure is `suspend()`
		// then `resume()`: deleting a pod, and every terminal in it, because
		// the agent was busy.
		//
		// This agent has in fact fenced itself, which is the sharp version of
		// the point: the flag is the ONLY evidence of a fence, so a reply that
		// does not carry it is `unreachable` — the probe learned nothing —
		// however true the guess would have been. Nothing is lost by saying
		// so, because the next call names the fence itself (see the case
		// above) and that error carries the cure.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setHealthzRefusal(
			'too_many_unauthenticated_connections: limit 64 (NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS)',
		)
		agent.setLosingExecutions(true)

		const failure = await workspace.exec('sleep', ['30']).catch((err: unknown) => err)
		expect((failure as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		expect(notices).toHaveLength(1)
		expect(notices[0]?.agent).toBe('unreachable')

		// And the rule the whole path exists for is unchanged: nothing written.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)
	}, 30_000)

	it('reports an agent that is still serving, and leaves it alone', async () => {
		// The third answer, and the only one whose advice is to do nothing.
		// The agent PROCESS restarted inside the pod: the pod's uid never
		// changed, so the token still admits and the host is talking to the
		// right guest — but the execution table went with the old process, so
		// every cancel is refused with `unknown_execution` and the window
		// closes unconfirmed. `handleCancelExecution` answers that before it
		// ever reaches `ensureTermination`, so nothing fenced itself: this is
		// the case where suspending the pod would delete a healthy one over a
		// single command's bookkeeping.
		const notices: KubernetesWorkspaceCancellationNotice[] = []
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: (notice) => notices.push(notice),
		})
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setForgetsExecutions(true)

		const failure = await workspace.exec('sleep', ['30']).catch((err: unknown) => err)
		expect((failure as Error).message).toMatch(/outcome is unknown|could not be confirmed/i)
		expect(failure).toMatchObject({
			retirement: { accepted: false, reason: 'workspace-kept' },
		})
		expect(notices).toHaveLength(1)
		expect(notices[0]?.agent).toBe('ok')

		// Nothing written, as on every other branch of this path.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)

		// And the agent really was serving: the next command runs on the same
		// pod, with no resume, no new pod and no fence to clear.
		agent.setForgetsExecutions(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)
		expect(presentedTokens().at(-1)).toBe(FIRST_POD_UID)
	}, 30_000)

	it('still lets a caller take the pod away from the callback', async () => {
		// The restoration path the changeset names: a host that wants the old
		// behaviour calls suspend() itself. The difference is that it is now
		// the host's decision, made where the host can see what else is in
		// that pod.
		//
		// A box rather than a `let workspace`, because the callback is handed
		// over before the handle exists — the same trick `startSession` uses
		// for the inner handle's own `release`. Nothing can call it in
		// between: it fires from a failing `exec()`.
		const held: { workspace?: KubernetesWorkspace } = {}
		let suspending: Promise<void> | undefined
		const workspace = await openWorkspace({
			onCancellationUnconfirmed: () => {
				suspending = held.workspace?.suspend()
			},
		})
		held.workspace = workspace
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setLosingExecutions(true)

		await workspace.exec('sleep', ['30']).catch(() => undefined)
		await suspending

		const patches = server.matching('PATCH', '/sandboxes/')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual(operatingModePatchBody('Suspended'))
		expect(workspace.suspended).toBe(true)
		await expect(workspace.exec('true')).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	}, 30_000)
})
