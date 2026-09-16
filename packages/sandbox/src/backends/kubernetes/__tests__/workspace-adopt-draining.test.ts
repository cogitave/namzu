/**
 * Adopting a workspace whose previous pod has not finished leaving yet.
 *
 * The create path and the resume path both already handle a pod that is on
 * the move: a create has nothing to wait for, and a resume knows the uid its
 * own suspend patch retired and polls until something else answers. Adoption
 * used to fall between them. It is the path a SECOND process takes — and a
 * second process arrives, by construction, at a moment the first one did not
 * choose:
 *
 *  - a `suspend()` that ended in `KubernetesWorkspaceSuspendTimeoutError`
 *    left a landed patch and a guest still riding out its
 *    `terminationGracePeriodSeconds`;
 *  - two hosts come up on one workspace during a rollout;
 *  - a host restarts inside the previous pod's termination grace period.
 *
 * In all three the only pod under the name carries a `deletionTimestamp`, so
 * it is never bound to — its uid is the agent's bind token and the
 * replacement agent refuses it — and the replacement has not been created
 * yet. The adopt therefore WAITS for it under the readiness budget it already
 * holds, exactly as a resume does, instead of failing on the first read that
 * finds no live pod.
 *
 * And the create path is asserted not to have moved with it: there nothing is
 * being replaced, so a pod that cannot be read is a failure to report at once
 * rather than a state to spend the whole budget waiting out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point: `origin` is public surface, and a
// host reads it off the value this verb returns.
import { createKubernetesWorkspace } from '../../../index.js'
import { KubernetesWorkspaceSuspendTimeoutError } from '../workspace.js'

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
const WORKSPACE_ID = 'handed-over'
const WORKSPACE_NAME = 'namzu-ws-handed-over'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=hov'
/** The pod that is leaving, and the one that replaces it. */
const OLD_POD_UID = '11111111-1111-4111-8111-111111111111'
const NEW_POD_UID = '22222222-2222-4222-8222-222222222222'

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

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

/** Whether a Sandbox of this name already stands there. The POST sets it. */
let exists: boolean
/** What the standing object's `spec.operatingMode` says. The PATCH moves it. */
let operatingMode: 'Running' | 'Suspended'
/**
 * Bind attempts still answered with no pod this handle may take.
 *
 * Consumed by the LIST rather than by the GET, because the list is the last
 * read of one `readPodBindToken` attempt: a GET that answers with a live pod
 * never reaches the list, so a counter at zero ends the wait on the read that
 * finds the replacement rather than one attempt later.
 */
let drainingAttempts: number
/**
 * What a draining read looks like. `terminating` is the pod still riding out
 * its grace period — same name, old uid, a `deletionTimestamp`. `gone` is the
 * window after it finally left and before the replacement was created, which
 * is the only shape an adopt of a suspended object sees.
 */
let drainingShape: 'terminating' | 'gone'
/** The uid a pod read answers with once the drain is over. */
let liveUid: string

beforeEach(async () => {
	exists = false
	operatingMode = 'Running'
	drainingAttempts = 0
	drainingShape = 'terminating'
	liveUid = OLD_POD_UID
	agent = await startScriptedAgent({ token: OLD_POD_UID })
	restoreDns = stubLoopbackDns()
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

/**
 * The pod on its way out: the same name, the old uid, a `deletionTimestamp`
 * — and phase `Running`, because the container does not stop when the DELETE
 * is accepted. Neither live (never bind it) nor stopped (it is still writing).
 */
function terminatingPod(uid: string): Record<string, unknown> {
	return {
		metadata: { name: WORKSPACE_NAME, uid, deletionTimestamp: '2026-09-16T00:00:01Z' },
		status: { phase: 'Running' },
	}
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		if (exists) {
			return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
		}
		exists = true
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const mode = (req.body as { spec?: { operatingMode?: string } }).spec?.operatingMode
		operatingMode = mode === 'Suspended' ? 'Suspended' : 'Running'
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME },
				spec: {
					operatingMode,
					volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
					podTemplate: TEMPLATE.spec.podTemplate,
				},
				status: {
					// Ready stays True while the pod is being replaced, which is
					// what makes the pod uid the only usable signal — see
					// workspace-suspend-resume.test.ts.
					conditions: [readyCondition(operatingMode === 'Suspended' ? 'False' : 'True')],
					podIPs: ['10.244.0.9'],
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: SELECTOR,
				},
			},
		}
	}
	// Before `/pods/`: the list path is `/pods?labelSelector=…`.
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (drainingAttempts > 0) {
			drainingAttempts -= 1
			return {
				status: 200,
				body: { items: drainingShape === 'terminating' ? [terminatingPod(OLD_POD_UID)] : [] },
			}
		}
		// The terminating pod first, so a reader that takes the head of the
		// list takes the one that is leaving.
		return { status: 200, body: { items: [terminatingPod(OLD_POD_UID), livePod(liveUid)] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (drainingAttempts > 0) {
			if (drainingShape === 'gone') return { status: 404, body: { message: 'gone' } }
			return { status: 200, body: terminatingPod(OLD_POD_UID) }
		}
		return { status: 200, body: livePod(liveUid) }
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

async function openWorkspace(overrides: { readyTimeoutMs?: number } = {}) {
	if (!server || !agent) throw new Error('fixtures not started')
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort: agent.port,
			readyTimeoutMs: 1_000,
			readyPollIntervalMs: 5,
			...overrides,
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
	)
}

/** Every token the guest has seen in a request envelope, in order. */
function presentedTokens(): string[] {
	if (!agent) throw new Error('fixtures not started')
	return agent.requests
		.map((request) => request.token)
		.filter((token): token is string => typeof token === 'string')
}

/** Hand the cluster and the guest over to the pod that replaces the old one. */
function replacementPodComesUp(attemptsFirst: number, shape: 'terminating' | 'gone'): void {
	if (!agent) throw new Error('fixtures not started')
	drainingAttempts = attemptsFirst
	drainingShape = shape
	liveUid = NEW_POD_UID
	agent.setToken(NEW_POD_UID)
}

describe('adopting a workspace that is still draining', () => {
	it('picks up a suspend that ran out of its own wait and binds the replacement', async () => {
		// The sharpest of the three: the first host's suspend PATCH LANDED and
		// only the wait on the pod ran out, so the controller is taking that
		// pod away and a second host arriving next finds the object Suspended
		// with a guest still writing to the disk. Before the fix the adopt read
		// the pod once, found nothing live, and rethrew.
		const first = await openWorkspace({ readyTimeoutMs: 300 })
		if (!server || !agent) throw new Error('fixtures not started')
		// A guest whose PID 1 ignores SIGTERM: the pod never reaches a stopped
		// phase inside the first host's budget.
		drainingAttempts = Number.POSITIVE_INFINITY
		await expect(first.suspend()).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendTimeoutError)

		// The second host, which knows none of that: it POSTs the same name,
		// gets the 409, and adopts.
		replacementPodComesUp(2, 'terminating')
		const listsBefore = server.matching('GET', '/pods?').length
		const second = await openWorkspace()

		expect(second.origin).toBe('resumed')
		expect(second.suspended).toBe(false)
		// It waited rather than failing: more than one read of the pod, and the
		// one it settled on was the replacement's.
		expect(drainingAttempts).toBe(0)
		expect(server.matching('GET', '/pods?').length - listsBefore).toBeGreaterThanOrEqual(2)
		expect(presentedTokens().at(-1)).toBe(NEW_POD_UID)
		expect((await second.exec('true')).exitCode).toBe(0)
	}, 20_000)

	it('waits out a pod that is terminating under a still-Running object', async () => {
		// The rollout case. Nothing suspended anything — the pod is simply
		// being replaced — so `operatingMode` says Running and the only thing
		// that says to wait is the `deletionTimestamp` on the pod standing
		// under the name.
		exists = true
		replacementPodComesUp(2, 'terminating')
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')

		expect(workspace.origin).toBe('adopted-running')
		expect(drainingAttempts).toBe(0)
		expect(server.matching('GET', '/pods?').length).toBeGreaterThanOrEqual(2)
		// The object was already Running, so nothing was patched on the way in
		// — and nothing was patched on the way out either, which is what a
		// successful adopt looks like.
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(presentedTokens().at(-1)).toBe(NEW_POD_UID)
		expect((await workspace.exec('true')).exitCode).toBe(0)
	}, 20_000)

	it('names the terminating pod when the readiness budget runs out', async () => {
		// The wait is bounded by the same `readyTimeoutMs` as everything else
		// on this path, and when it runs out the operator is told which pod is
		// still sitting there rather than being handed the generic "could not
		// read a pod uid".
		exists = true
		drainingAttempts = Number.POSITIVE_INFINITY
		// The default budget rather than a clipped one: the wording asserted
		// below is the POD wait's, and a budget short enough to expire inside
		// the first readiness read would be reported — correctly — as the
		// Sandbox never becoming Ready instead.
		const failure = await openWorkspace().catch((err: unknown) => err)
		if (!server) throw new Error('fixtures not started')

		expect(failure).toBeInstanceOf(Error)
		const message = (failure as Error).message
		expect(message).toContain(OLD_POD_UID)
		expect(message).toMatch(/TERMINATING/)
		expect(message).toMatch(/terminationGracePeriodSeconds/)
		expect(message).toMatch(/readyTimeoutMs/)
		// It really waited: a single read would have failed in milliseconds.
		expect(server.matching('GET', '/pods?').length).toBeGreaterThanOrEqual(2)
		// And the read it kept getting is on the error, not thrown away.
		expect((failure as Error).cause).toBeInstanceOf(Error)
		// A create or adopt that fails after the object exists suspends it and
		// rethrows. Nothing is ever deleted on a failure path.
		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual({ spec: { operatingMode: 'Suspended' } })
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	}, 20_000)

	it('leaves the created path failing on the first read, not polling', async () => {
		// The other half of the fix: this call POSTed the object, so no pod is
		// being replaced and there is nothing coming. Polling would spend the
		// whole readiness budget before saying exactly what the first answer
		// already said.
		drainingAttempts = Number.POSITIVE_INFINITY
		drainingShape = 'gone'
		const failure = await openWorkspace().catch((err: unknown) => err)
		if (!server) throw new Error('fixtures not started')

		expect((failure as Error).message).toMatch(/could not read a pod uid/)
		// One attempt. Not one more.
		expect(server.matching('GET', '/pods?')).toHaveLength(1)
	}, 20_000)
})

describe('how the handle came by its workspace', () => {
	it('reports created when this call POSTed the object', async () => {
		const workspace = await openWorkspace()
		expect(workspace.origin).toBe('created')
		expect(workspace.suspended).toBe(false)
	})

	it('reports adopted-running when the object was already up', async () => {
		exists = true
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		expect(workspace.origin).toBe('adopted-running')
		// Nothing was woken: it was already awake.
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
	})

	it('reports resumed when the object was asleep, and waits for its new pod', async () => {
		// The suspended object's pod is already gone — there is no terminating
		// pod to exclude, only a window with no pod at all. That is the shape
		// the old code could not express: with nothing to exclude it treated
		// the first failed read as fatal.
		exists = true
		operatingMode = 'Suspended'
		replacementPodComesUp(2, 'gone')
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')

		expect(workspace.origin).toBe('resumed')
		expect(workspace.suspended).toBe(false)
		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual({ spec: { operatingMode: 'Running' } })
		expect(drainingAttempts).toBe(0)
		expect(presentedTokens().at(-1)).toBe(NEW_POD_UID)
	}, 20_000)

	it('does not rewrite origin across a later suspend and resume', async () => {
		// `origin` answers what this call walked into, not what state the
		// workspace is in now — which is what `suspended` is for.
		exists = true
		const workspace = await openWorkspace()
		expect(workspace.origin).toBe('adopted-running')
		// The pod leaves for good, so the suspend confirms rather than running
		// out its wait: this case is about `origin` surviving a transition,
		// not about the transition.
		drainingAttempts = Number.POSITIVE_INFINITY
		drainingShape = 'gone'
		await workspace.suspend()

		expect(workspace.suspended).toBe(true)
		expect(workspace.origin).toBe('adopted-running')
	}, 20_000)
})
