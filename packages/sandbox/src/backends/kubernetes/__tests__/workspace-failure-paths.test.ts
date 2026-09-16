/**
 * What a start that FAILED is allowed to do to a workspace somebody else is
 * using.
 *
 * A workspace id is a name, not a lock: two host processes hold handles to
 * one workspace by design, because coming back after a restart or during a
 * rollout is what the deterministic name is for. So the second process
 * arrives at a moment the first one did not choose, and it arrives through
 * the same code — a 409 on the POST, then an adopt.
 *
 * The failures that meet it there are not failures OF the workspace. A
 * caller's signal aborting during readiness, one 5xx or 429 on a Sandbox or
 * pod GET (the client does not retry), a privilege probe that overran its
 * own deadline: every one of them can happen to a second process while the
 * first is happily executing in the pod. Sending `operatingMode: Suspended`
 * on all of them made the controller DELETE that pod — every terminal, dev
 * server and running command in it, for every holder — on a decision no
 * caller issued and no host-side lock could prevent.
 *
 * The rule these cases pin is therefore not "do not suspend on failure" but
 * "suspend only what THIS call changed": a create that POSTed the object, or
 * an adopt or resume whose Running patch took the object out of `Suspended`,
 * still puts it back, because a workspace this call woke and then failed to
 * start would otherwise be left Running with a pod nobody is using. Both
 * halves are asserted here, because getting the first one right by removing
 * the patch entirely is the other way to be wrong.
 *
 * One substitution to be honest about: the issue's acceptance criterion says
 * the first process's open TERMINAL survives. The scripted agent serves no
 * `terminal` op (the real agent does, but it cannot pass the privilege probe
 * on a test host — see `fixtures/scripted-agent.ts`), so what is asserted
 * instead is the thing a terminal's survival depends on: the pod was never
 * asked to go away. No PATCH, `operatingMode` still `Running`, the same pod
 * uid behind the name, and the first handle's next call still served.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point rather than the backend-local one:
// `onStartFailure` is public surface and a host passes it to this verb.
import { createKubernetesWorkspace } from '../../../index.js'
import type { KubernetesWorkspace, KubernetesWorkspaceStartFailurePolicy } from '../workspace.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	operatingModePatchBody,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import {
	DEPRIVILEGED_PROC_STATUS,
	PRIVILEGED_PROC_STATUS,
	type ScriptedAgent,
	startScriptedAgent,
} from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'shared-desk'
const WORKSPACE_NAME = 'namzu-ws-shared-desk'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=shd'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'

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

/**
 * What the standing object's `spec` says — the shape a create POSTed, which
 * an ADOPT re-checks against its own configuration rather than trusting.
 * Without it every adopt in this file fails on the disk check before it
 * reaches the failure the case is about.
 */
const STANDING_SPEC = {
	podTemplate: TEMPLATE.spec.podTemplate,
	volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
}

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

/** The object's own state, moved only by a POST and by the two patches. */
let exists: boolean
let operatingMode: 'Running' | 'Suspended'
/** The uid the pod GET answers with. A resume brings back a new one. */
let podUid: string
/**
 * Called on every Sandbox GET, before the reply is built, so a case can act
 * at a point INSIDE somebody's readiness poll — abort a signal, arm a 503 —
 * rather than guessing at a delay. It answers a reply to send instead of the
 * normal one, or `undefined` to let the read through.
 */
let onSandboxRead: (() => FakeApiReply | undefined) | undefined

beforeEach(async () => {
	exists = false
	operatingMode = 'Running'
	podUid = FIRST_POD_UID
	onSandboxRead = undefined
	agent = await startScriptedAgent({ host: '0.0.0.0' })
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
		// A resume brings back a NEW pod, exactly as the controller does: the
		// uid is the agent's bind token, so a fixture that reused it would let
		// a handle bind to a pod that no longer exists and call it a pass.
		if (mode !== 'Suspended' && operatingMode === 'Suspended') podUid = SECOND_POD_UID
		operatingMode = mode === 'Suspended' ? 'Suspended' : 'Running'
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		const intercepted = onSandboxRead?.()
		if (intercepted !== undefined) return intercepted
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME },
				spec: { ...STANDING_SPEC, operatingMode },
				status: {
					conditions: [readyCondition(operatingMode === 'Suspended' ? 'False' : 'True')],
					podIPs: ['10.244.0.9'],
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: SELECTOR,
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (operatingMode === 'Suspended') return { status: 200, body: { items: [] } }
		return { status: 200, body: { items: [livePod()] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (operatingMode === 'Suspended') return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod() }
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

function livePod(): Record<string, unknown> {
	return { metadata: { name: WORKSPACE_NAME, uid: podUid }, status: { phase: 'Running' } }
}

async function openWorkspace(
	options: {
		signal?: AbortSignal
		onStartFailure?: KubernetesWorkspaceStartFailurePolicy
	} = {},
): Promise<KubernetesWorkspace> {
	if (!server || !agent) throw new Error('fixtures not started')
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
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace', ...options },
	)
}

/** Every PATCH the fake cluster recorded from `from` onwards. */
function patchesSince(from: number): readonly RecordedRequest[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests.slice(from).filter((r) => r.method === 'PATCH')
}

/** How many Sandbox GETs the fake cluster served from `from` onwards. */
function sandboxReadsSince(from: number): number {
	if (!server) throw new Error('fixtures not started')
	return server.requests
		.slice(from)
		.filter((r) => r.method === 'GET' && r.path.includes('/sandboxes/')).length
}

/** Fail the Nth Sandbox GET from now with a 503, and only that one. */
function failSandboxReadAfter(reads: number): void {
	let remaining = reads
	onSandboxRead = () => {
		if (remaining > 0) {
			remaining -= 1
			return undefined
		}
		onSandboxRead = undefined
		return { status: 503, body: { message: 'etcdserver: request timed out' } }
	}
}

describe('a second process whose start fails', () => {
	/**
	 * The shared arrangement: a first handle, running, with a pod behind it —
	 * and the assertion every case makes afterwards, which is that nothing
	 * about either changed.
	 */
	async function withHolder(fail: () => Promise<unknown>): Promise<{
		holder: KubernetesWorkspace
		failure: unknown
		patches: readonly RecordedRequest[]
	}> {
		if (!server) throw new Error('fixtures not started')
		const holder = await openWorkspace()
		const before = server.requests.length
		const failure = await fail().then(
			(value) => value,
			(err: unknown) => err,
		)
		return { holder, failure, patches: patchesSince(before) }
	}

	async function expectUntouched(holder: KubernetesWorkspace): Promise<void> {
		if (!server) throw new Error('fixtures not started')
		// The object was never asked to give its pod back...
		expect(operatingMode).toBe('Running')
		expect(podUid).toBe(FIRST_POD_UID)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		// ...so the first handle is still serving out of it.
		expect(holder.suspended).toBe(false)
		expect((await holder.exec('true')).exitCode).toBe(0)
	}

	it('sends nothing when its privilege probe refuses the pod', async () => {
		if (!agent) throw new Error('fixtures not started')
		const { holder, failure, patches } = await withHolder(async () => {
			// The pod the SECOND process probes is the one the first is using,
			// and a probe refusal is the failure most likely to look like the
			// workspace's own fault.
			agent?.setStdout(PRIVILEGED_PROC_STATUS)
			return await openWorkspace()
		})

		expect((failure as Error).message).toMatch(/privile|capabilit|NoNewPrivs/i)
		expect(patches).toHaveLength(0)
		agent.setStdout(DEPRIVILEGED_PROC_STATUS)
		await expectUntouched(holder)
	})

	it('sends nothing when its own signal aborts during readiness', async () => {
		const controller = new AbortController()
		const { holder, failure, patches } = await withHolder(async () => {
			// Aborted from INSIDE the readiness poll — the window a caller's
			// own cancellation actually lands in — rather than before the
			// call. The adopt's own read is the first; the poll's is the next.
			let reads = 0
			onSandboxRead = () => {
				reads += 1
				if (reads > 1) controller.abort(new Error('the caller gave up'))
				return undefined
			}
			return await openWorkspace({ signal: controller.signal })
		})

		// The caller's own reason, not a readiness timeout wearing its clothes.
		expect((failure as Error).message).toBe('the caller gave up')
		expect(patches).toHaveLength(0)
		await expectUntouched(holder)
	})

	it('sends nothing when one readiness read comes back 503', async () => {
		const { holder, failure, patches } = await withHolder(async () => {
			// One read: the adopt's own, which must succeed for the call to get
			// as far as the poll this case is about. The client does not retry,
			// so the next one is fatal.
			failSandboxReadAfter(1)
			return await openWorkspace()
		})

		expect((failure as Error).message).toMatch(/503/)
		expect(patches).toHaveLength(0)
		await expectUntouched(holder)
	})

	it('sends nothing when its resume finds the workspace already awake', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		// The other half of the issue: not an adopt, but a `resume()` on a
		// handle whose workspace somebody else has already brought back.
		const second = await openWorkspace()
		await second.suspend()
		// Another process wakes it and takes the new pod.
		agent.setToken(undefined)
		const holder = await openWorkspace()
		expect(holder.origin).toBe('resumed')
		expect(operatingMode).toBe('Running')

		const before = server.requests.length
		// One read gets through — `resume()`'s own `spec.operatingMode` read,
		// which is what tells it the object is already awake — and the 503
		// lands on the next one, the readiness poll INSIDE the session start.
		// `failSandboxReadAfter(0)` would kill the mode read itself and prove
		// only that a failed read sends no patch, never reaching the branch
		// this case exists for.
		failSandboxReadAfter(1)
		const failure = await second.resume().then(
			() => undefined,
			(err: unknown) => err,
		)

		expect((failure as Error | undefined)?.message).toMatch(/503/)
		// Both reads happened, in that order: the mode read that answered
		// `Running`, then the one that failed. Without this the case would
		// still pass if the mode read were dropped or moved after the patch.
		expect(sandboxReadsSince(before)).toBe(2)
		// Not one patch: this resume found the object Running, so it woke
		// nothing — no `Running` patch on the way in, which is what proves the
		// read answered `Running`, and nothing to put back on the way out. The
		// pod it would have taken away is the one the other handle is
		// executing in.
		expect(patchesSince(before)).toHaveLength(0)
		expect(operatingMode).toBe('Running')
		expect(podUid).toBe(SECOND_POD_UID)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(holder.suspended).toBe(false)
		expect((await holder.exec('true')).exitCode).toBe(0)
	})
})

describe('a start failure that DID wake the workspace', () => {
	it('puts a workspace its own adopt woke back to sleep', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		// The inverse hazard, and the reason the rule is "suspend only what
		// this call changed" rather than "never suspend": a workspace this
		// call woke and then failed to start is left Running with a pod
		// nobody is using, burning a node until somebody notices.
		const first = await openWorkspace()
		await first.suspend()
		expect(operatingMode).toBe('Suspended')
		const before = server.requests.length

		agent.setStdout(PRIVILEGED_PROC_STATUS)
		agent.setToken(undefined)
		await expect(openWorkspace()).rejects.toThrow(/privile|capabilit|NoNewPrivs/i)

		const patches = patchesSince(before)
		expect(patches.map((p) => p.body)).toEqual([
			operatingModePatchBody('Running'),
			operatingModePatchBody('Suspended'),
		])
		expect(operatingMode).toBe('Suspended')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})

	it('puts a workspace its own create made back to sleep', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		// A create POSTed the object, so the pod exists because of this call
		// and nobody else can be using it. The suspend leaves the object and
		// its disk standing under the same deterministic name — a named leak,
		// deliberately, because two processes can be coming up on one name and
		// deleting "its own" object would take the other's disk.
		agent.setStdout(PRIVILEGED_PROC_STATUS)

		await expect(openWorkspace()).rejects.toThrow(/privile|capabilit|NoNewPrivs/i)

		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual(operatingModePatchBody('Suspended'))
		expect(operatingMode).toBe('Suspended')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})
})

describe("onStartFailure: 'leave'", () => {
	it('sends no patch even for a wake this call performed', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		// The opt-out, for a host that keeps its own holder record and sweeps
		// idle workspaces itself. It is the one rule with no exception: the
		// only patch on the record is the Running one this adopt sent on the
		// way in.
		const first = await openWorkspace()
		await first.suspend()
		const before = server.requests.length

		agent.setStdout(PRIVILEGED_PROC_STATUS)
		agent.setToken(undefined)
		await expect(openWorkspace({ onStartFailure: 'leave' })).rejects.toThrow(
			/privile|capabilit|NoNewPrivs/i,
		)

		expect(patchesSince(before).map((p) => p.body)).toEqual([operatingModePatchBody('Running')])
		expect(operatingMode).toBe('Running')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})

	it('sends no patch on a create that failed after its own POST', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		agent.setStdout(PRIVILEGED_PROC_STATUS)

		await expect(openWorkspace({ onStartFailure: 'leave' })).rejects.toThrow(
			/privile|capabilit|NoNewPrivs/i,
		)

		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(operatingMode).toBe('Running')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})

	it('is overridable for one resume through the transition options', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		// The handle's policy is the default; a transition may narrow or widen
		// it for one call. Here the handle was opened `leave` and this one
		// resume asks for the default back — and gets it, because this resume
		// is the call that woke the workspace.
		const workspace = await openWorkspace({ onStartFailure: 'leave' })
		await workspace.suspend()
		const before = server.requests.length

		agent.setStdout(PRIVILEGED_PROC_STATUS)
		agent.setToken(undefined)
		await expect(workspace.resume({ onStartFailure: 'suspend-if-woken' })).rejects.toThrow(
			/privile|capabilit|NoNewPrivs/i,
		)

		expect(patchesSince(before).map((p) => p.body)).toEqual([
			operatingModePatchBody('Running'),
			operatingModePatchBody('Suspended'),
		])
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})
})
