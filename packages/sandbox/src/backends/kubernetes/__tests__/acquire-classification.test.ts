/**
 * Why an acquire was refused, and what a host is supposed to do about it.
 *
 * The defect these cover is not that acquires fail — it is that every failure
 * used to look the same. A claim the controller had already REFUSED burned
 * the whole readiness budget before surfacing as a message about a clock; a
 * single 429 from a shared API server failed a create that had a minute of
 * budget left; and a burst past node capacity and an API outage were both a
 * plain `Error` whose only distinguishing feature was wording.
 *
 * So the assertions here are about the diagnosis, not the failure:
 *
 *  - a terminal controller reason fails within ONE poll, asserted by the
 *    RECORDED REQUEST COUNT rather than by elapsed time (a wall-clock
 *    assertion on a 60 s budget passes on a machine that is merely fast);
 *  - a transient API failure is repeated inside the budget, and the count
 *    proves it was repeated rather than rethrown;
 *  - a refusal always leaves no claim behind, whichever reason it carried;
 *  - and a clean acquire's request log is pinned, so none of the above added
 *    a round trip to the path that matters.
 *
 * The controller reason STRINGS are the one input this repo cannot invent —
 * it vendors none of agent-sandbox's source — so they were read off the
 * deployed controller and are cited where they are used. See
 * `TERMINAL_CLAIM_REASONS` in `../index.ts` for the table and how each was
 * produced.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KubernetesAcquireError,
	KubernetesAlreadyGoneError,
	KubernetesApiError,
	KubernetesApiTimeoutError,
	KubernetesConflictError,
	KubernetesCredentialError,
	KubernetesEgressPolicyMismatchError,
	KubernetesEgressPolicyNotAppliedError,
	KubernetesUnenforceableEgressPolicyError,
	ReadinessPollTimeout,
	TERMINAL_CLAIM_REASONS,
} from '../../../index.js'
import { buildKubernetesBackend } from '../index.js'
import {
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const POOL_SANDBOX_NAME = 'classify-pool-sandbox-1a2b3'
const POD_UID = '8b7c6d5e-4f3a-2b1c-0d9e-8f7a6b5c4d3e'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

beforeEach(async () => {
	agent = await startScriptedAgent({ token: POD_UID })
	restoreDns = stubLoopbackDns()
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function backend(
	overrides: {
		readyTimeoutMs?: number
		apiRequestTimeoutMs?: number
		warmPoolName?: string | undefined
		serverUrl?: string
	} = {},
) {
	if (!server || !agent) throw new Error('fixtures not started')
	const { serverUrl, ...rest } = overrides
	return buildKubernetesBackend({
		access: {
			server: serverUrl ?? server.url,
			getToken: async () => 'sa-token',
		},
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		agentPort: agent.port,
		readyTimeoutMs: 400,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		// The warm path unless a case says otherwise, and the KEY's presence
		// decides rather than its value: `warmPoolName: undefined` is how a
		// case asks for the pool-less path, and a value test would hand it
		// the default pool instead.
		...('warmPoolName' in overrides ? {} : { warmPoolName: 'namzu-task-pool' }),
		...rest,
	})
}

/** Reject, and hand the error back rather than a matcher's opinion of it. */
async function refusal(pending: Promise<unknown>): Promise<unknown> {
	return await pending.then(
		() => {
			throw new Error('the acquire resolved; it was expected to be refused')
		},
		(err: unknown) => err,
	)
}

function acquireError(err: unknown): KubernetesAcquireError {
	expect(err).toBeInstanceOf(KubernetesAcquireError)
	return err as KubernetesAcquireError
}

/** The control-plane request log as `METHOD path-without-the-uuid`. */
function trace(requests: readonly RecordedRequest[]): string[] {
	return requests.map((r) => `${r.method} ${r.path.replace(/namzu-task-[0-9a-f-]{36}/, '<name>')}`)
}

/**
 * A claim the controller has refused, in exactly the shape it publishes one:
 * `Ready=False`, a reason, a message, and `status.sandbox` left empty.
 * Measured against agent-sandbox v1.0.2 on kind v1.37.0 (2026-09-17).
 */
function rejectedClaim(reason: string, message: string): Record<string, unknown> {
	return {
		status: {
			conditions: [
				{
					type: 'Ready',
					status: 'False',
					reason,
					message,
					lastTransitionTime: '2026-09-17T01:57:43Z',
					observedGeneration: 1,
				},
			],
			sandbox: {},
		},
	}
}

/** A claim that is working: Ready=False for the reason a cold start reports. */
const COLD_START_CLAIM = {
	status: {
		conditions: [
			{
				type: 'Ready',
				status: 'False',
				reason: 'DependenciesNotReady',
				message: 'Pod exists with phase: Pending',
				lastTransitionTime: '2026-09-17T02:08:38Z',
				observedGeneration: 1,
			},
		],
		// Published BEFORE Ready on a cold start — measured on kind — which is
		// what makes a pod-level diagnosis reachable on the warm path at all.
		sandbox: { name: POOL_SANDBOX_NAME },
	},
}

const READY_CLAIM = {
	status: {
		conditions: [readyCondition()],
		sandbox: {
			name: POOL_SANDBOX_NAME,
			podIPs: ['10.244.0.6'],
			serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
		},
	},
}

const READY_POD = { metadata: { name: POOL_SANDBOX_NAME, uid: POD_UID } }

/** The least a `SandboxTemplate` can be and still build a body. */
const TEMPLATE_REPLY = {
	metadata: { name: 'namzu-task', namespace: NAMESPACE },
	spec: {
		service: true,
		podTemplate: {
			spec: { containers: [{ name: 'main', image: 'namzu/agent:test' }] },
		},
	},
}

describe('a claim the controller has refused', () => {
	// One case per reason `TERMINAL_CLAIM_REASONS` lists, each with the exact
	// message the deployed controller wrote, so a reason that is renamed
	// upstream fails here rather than silently stopping the fail-fast.
	const cases: readonly { reason: string; message: string }[] = [
		{
			reason: 'WarmPoolNotFound',
			message: 'SandboxWarmPool "no-such-pool" not found',
		},
		{
			reason: 'TemplateNotFound',
			message: 'SandboxTemplate "no-such-template" not found',
		},
		{
			reason: 'InvalidMetadata',
			message:
				'invalid additionalPodMetadata: failed to validate label "evil.example.com/hack": label domain "evil.example.com" is not in the allowlist',
		},
		{
			reason: 'EnvVarsInjectionRejected',
			message:
				'environment variable injection rejected: environment variable injection is not allowed by the template policy',
		},
	]

	for (const { reason, message } of cases) {
		it(`fails within one poll on ${reason}, carrying the controller's own words`, async () => {
			server = await startFakeApiServer((req) => {
				if (req.method === 'POST') return { status: 201, body: {} }
				if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
					return { status: 200, body: rejectedClaim(reason, message) }
				}
				if (req.method === 'DELETE') return { status: 200, body: {} }
				return { status: 404, body: {} }
			})

			// A 60 s budget on purpose: a wall-clock assertion would pass here
			// for the wrong reason on a fast machine, so the proof is that the
			// claim was read ONCE. Three requests: create, read, release.
			const error = acquireError(
				await refusal(
					backend({ readyTimeoutMs: 60_000 }).create({
						workingDirectory: '/workspace',
					}),
				),
			)

			expect(error.reason).toBe('claim-rejected')
			expect(error.retryable).toBe(false)
			expect(error.controllerReason).toBe(reason)
			expect(error.controllerMessage).toBe(message)
			expect(error.message).toContain(reason)
			expect(error.message).toContain(message)
			expect(server.matching('GET', '/sandboxclaims/')).toHaveLength(1)
			expect(trace(server.requests)).toEqual([
				`POST /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims`,
				`GET /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims/<name>`,
				`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims/<name>`,
			])
		})
	}

	it('waits out the deadline on a reason it does not recognise, rather than guessing', async () => {
		// The literals came from a cluster, not from source this repo vendors,
		// so a wrong one must fail SAFE. Too few entries costs a doomed acquire
		// its budget, which is what every release before this did. Too many
		// would refuse an acquire that was going to succeed.
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: rejectedClaim('SomeReasonAFutureControllerInvents', 'no idea'),
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('not-ready')
		expect(error.controllerReason).toBeUndefined()
		expect(error.cause).toBeInstanceOf(ReadinessPollTimeout)
		// Polled repeatedly, which is the behaviour being preserved.
		expect(server.matching('GET', '/sandboxclaims/').length).toBeGreaterThan(2)
	})

	it('does not read a transient Ready=False as a refusal', async () => {
		let polls = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				polls += 1
				if (polls < 3) return { status: 200, body: COLD_START_CLAIM }
				return { status: 200, body: READY_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: READY_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		await sandbox.destroy()
	})
})

describe('a transient API failure', () => {
	it('retries a 429 for the length Retry-After asked for, then succeeds', async () => {
		let claimReads = 0
		let waitedFor: number | undefined
		let refusedAt = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				if (claimReads === 1) {
					refusedAt = performance.now()
					return {
						status: 429,
						headers: { 'retry-after': '1' },
						body: { message: 'too many requests' },
					}
				}
				waitedFor ??= performance.now() - refusedAt
				return { status: 200, body: READY_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: READY_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ readyTimeoutMs: 6_000 }).create({
			workingDirectory: '/workspace',
		})

		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		expect(claimReads).toBe(2)
		// `Retry-After: 1` is one SECOND, not one poll interval. Without the
		// header the next read would have been 5 ms later.
		expect(waitedFor ?? 0).toBeGreaterThanOrEqual(900)
		await sandbox.destroy()
	})

	it('retries three 503s and then succeeds', async () => {
		let claimReads = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				if (claimReads <= 3) return { status: 503, body: { message: 'apiserver unavailable' } }
				return { status: 200, body: READY_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: READY_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ readyTimeoutMs: 4_000 }).create({
			workingDirectory: '/workspace',
		})

		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		expect(claimReads).toBe(4)
		await sandbox.destroy()
	})

	it('retries a reset connection, which has no status at all', async () => {
		let claimReads = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				// The one failure with no status: `transport: 'connect'`.
				if (claimReads <= 2) return { status: 0, reset: true }
				return { status: 200, body: READY_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: READY_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ readyTimeoutMs: 4_000 }).create({
			workingDirectory: '/workspace',
		})

		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		expect(claimReads).toBe(3)
		await sandbox.destroy()
	})

	it('waits rather than spins when Retry-After names a moment years away', async () => {
		// A delay past `setTimeout`'s ceiling fires IMMEDIATELY rather than
		// never, so an unclamped `Retry-After` would turn the retry into a hot
		// loop from the opposite direction to a `Retry-After: 0`. The readiness
		// deadline still ends it; what is asserted here is that the budget was
		// spent waiting rather than spent hammering.
		let claimReads = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				return {
					status: 503,
					headers: { 'retry-after': '99999999' },
					body: { message: 'unavailable' },
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('api-unreachable')
		// One read, then a wait the deadline ended — not four hundred reads.
		expect(claimReads).toBe(1)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('does not retry a 403, and names it as the credential failure it is', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 403,
					body: {
						message: 'sandboxclaims.extensions.agents.x-k8s.io is forbidden',
					},
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(
			await refusal(
				backend({ readyTimeoutMs: 60_000 }).create({
					workingDirectory: '/workspace',
				}),
			),
		)

		expect(error.reason).toBe('forbidden')
		expect(error.retryable).toBe(false)
		expect(error.cause).toBeInstanceOf(KubernetesCredentialError)
		// Read once. A decision is not a delay.
		expect(server.matching('GET', '/sandboxclaims/')).toHaveLength(1)
	})
})

describe('a pod that cannot start', () => {
	/**
	 * `PodScheduled=False` with reason `Unschedulable`, in the exact shape a
	 * v1.37.0 API server publishes it (measured on kind, 2026-09-17).
	 */
	const UNSCHEDULABLE_POD = {
		metadata: { name: POOL_SANDBOX_NAME },
		status: {
			phase: 'Pending',
			conditions: [
				{
					type: 'PodScheduled',
					status: 'False',
					reason: 'Unschedulable',
					message: "0/1 nodes are available: 1 node(s) didn't match Pod's node affinity/selector.",
					lastTransitionTime: '2026-09-17T01:58:47Z',
				},
			],
		},
	}

	/** `ErrImagePull`, in the kubelet's own shape (same cluster, same day). */
	const IMAGE_PULL_POD = {
		metadata: { name: POOL_SANDBOX_NAME },
		status: {
			phase: 'Pending',
			containerStatuses: [
				{
					name: 'main',
					ready: false,
					state: {
						waiting: {
							reason: 'ImagePullBackOff',
							message: 'Back-off pulling image "registry.k8s.io/namzu-no-such-image:0.0.0"',
						},
					},
				},
			],
		},
	}

	function serveColdClaimWithPod(pod: unknown) {
		return startFakeApiServer((req: RecordedRequest) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: COLD_START_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: pod }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})
	}

	it('reports capacity when the scheduler could not place it', async () => {
		server = await serveColdClaimWithPod(UNSCHEDULABLE_POD)

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('capacity')
		expect(error.retryable).toBe(true)
		expect(error.cause).toBeInstanceOf(ReadinessPollTimeout)
		// Asked ONCE, after the budget had already gone — never on the healthy
		// path, where a pod read per poll would double the request count.
		expect(server.matching('GET', '/pods/')).toHaveLength(1)
		// And asked BEFORE the release, because the pod goes with the object.
		const podAt = server.requests.findIndex((r) => r.path.includes('/pods/'))
		const deleteAt = server.requests.findIndex((r) => r.method === 'DELETE')
		expect(podAt).toBeLessThan(deleteAt)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('reports image-pull when the container image will not pull', async () => {
		server = await serveColdClaimWithPod(IMAGE_PULL_POD)

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('image-pull')
		// Nothing about waiting longer fixes a reference that does not resolve.
		expect(error.retryable).toBe(false)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('leaves the reason alone when the pod has nothing to say', async () => {
		server = await serveColdClaimWithPod({
			metadata: { name: POOL_SANDBOX_NAME },
			status: {
				phase: 'Pending',
				conditions: [{ type: 'PodScheduled', status: 'True' }],
			},
		})

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('not-ready')
		expect(error.retryable).toBe(true)
	})

	/**
	 * A claim that publishes its sandbox name and stays cold forever, with one
	 * transient API failure dropped in at `blipAt` — the interleaving a real
	 * saturated cluster produces and the one the first version of this code
	 * got wrong: a pod nothing can schedule AND an API server shedding load,
	 * at the same time.
	 */
	function serveColdClaimWithBlipAndPod(pod: unknown, blipAt: number) {
		let claimReads = 0
		return startFakeApiServer((req: RecordedRequest) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				if (claimReads === blipAt) {
					return { status: 503, body: { message: 'apiserver unavailable' } }
				}
				return { status: 200, body: COLD_START_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: pod }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})
	}

	it('still reports capacity when one retried blip happened earlier in the poll', async () => {
		// What the cluster SAID outranks what the failures suggest. A single
		// 503 the poll recovered from must not rename an unschedulable pod as
		// an API outage — least of all on a saturated cluster, which is both
		// the condition `capacity` exists to name and the condition a 429 is
		// most likely to arrive in.
		server = await serveColdClaimWithBlipAndPod(UNSCHEDULABLE_POD, 2)

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('capacity')
		expect(error.retryable).toBe(true)
		expect(server.matching('GET', '/sandboxclaims/').length).toBeGreaterThan(2)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('still reports image-pull, and still not retryable, after a retried blip', async () => {
		// The costly half of the same defect: `image-pull` is the one reason
		// carrying `retryable: false`, so mistaking it for an API outage tells
		// a host to keep trying an image reference that will never resolve,
		// creating and deleting a claim every round.
		server = await serveColdClaimWithBlipAndPod(IMAGE_PULL_POD, 2)

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('image-pull')
		expect(error.retryable).toBe(false)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('does not blame a recovered blip for a poll that simply ran out of time', async () => {
		// The same staleness, seen at the timeout rather than at the reason: a
		// poll that met one failure, recovered and then spent its budget on a
		// pod that was merely slow must not carry that failure as its cause or
		// quote it in its message.
		server = await serveColdClaimWithBlipAndPod(
			{
				metadata: { name: POOL_SANDBOX_NAME },
				status: {
					phase: 'Pending',
					conditions: [{ type: 'PodScheduled', status: 'True' }],
				},
			},
			2,
		)

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('not-ready')
		const pollTimeout = error.cause as ReadinessPollTimeout
		expect(pollTimeout).toBeInstanceOf(ReadinessPollTimeout)
		expect(pollTimeout.cause).toBeUndefined()
		expect(pollTimeout.message).not.toContain('the last API failure retried')
	})

	it('falls back to the API failure when the diagnosis cannot be made either', async () => {
		// The other side of the precedence: a pod condition only outranks the
		// cause when there IS one. Here the control plane is still failing at
		// the deadline and fails the diagnosis read too, so the failure the
		// poll was meeting is the honest answer.
		let claimReads = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				claimReads += 1
				// One answer, so the sandbox name is published and a pod read
				// is even attempted; then the API stops answering for good.
				if (claimReads === 1) return { status: 200, body: COLD_START_CLAIM }
				return { status: 503, body: { message: 'apiserver unavailable' } }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 503, body: { message: 'apiserver unavailable' } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('api-unreachable')
		expect(error.retryable).toBe(true)
		const pollTimeout = error.cause as ReadinessPollTimeout
		expect(pollTimeout).toBeInstanceOf(ReadinessPollTimeout)
		expect(pollTimeout.cause).toBeInstanceOf(KubernetesApiError)
		expect(server.matching('GET', '/pods/')).toHaveLength(1)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it("diagnoses the pool-less path from the Sandbox's own pod", async () => {
		// A directly created Sandbox is backed by a pod of its own name, so
		// the diagnosis is reachable there without a claim ever binding one —
		// and when that pod does not exist, the 404 is swallowed and the
		// acquire keeps the reason it already had.
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: TEMPLATE_REPLY }
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
				return { status: 201, body: {} }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				const name = req.path.split('/sandboxes/')[1] ?? ''
				return {
					status: 200,
					body: {
						metadata: { name },
						status: { conditions: [readyCondition('False')] },
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: UNSCHEDULABLE_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(
			await refusal(
				backend({ warmPoolName: undefined }).create({
					workingDirectory: '/workspace',
				}),
			),
		)

		expect(error.reason).toBe('capacity')
		expect(server.matching('GET', '/pods/')).toHaveLength(1)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('does not turn a failed diagnosis into a second failure', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: COLD_START_CLAIM }
			}
			// The diagnosis read itself fails. The acquire failure is primary.
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return {
					status: 500,
					body: { message: 'etcdserver: request timed out' },
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = acquireError(await refusal(backend().create({ workingDirectory: '/workspace' })))

		expect(error.reason).toBe('not-ready')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('an API server that cannot be reached', () => {
	it('names a refused connection as api-unreachable', async () => {
		// Nothing is listening. The fake server is started anyway so the
		// fixtures' teardown is symmetrical with every other case.
		server = await startFakeApiServer(() => ({ status: 404, body: {} }))
		const closedPort = await (async () => {
			const scratch = await startFakeApiServer(() => ({
				status: 200,
				body: {},
			}))
			const url = scratch.url
			await scratch.close()
			return url
		})()

		const error = acquireError(
			await refusal(
				backend({ serverUrl: closedPort }).create({
					workingDirectory: '/workspace',
				}),
			),
		)

		expect(error.reason).toBe('api-unreachable')
		expect(error.retryable).toBe(true)
		const cause = error.cause as KubernetesApiError
		expect(cause).toBeInstanceOf(KubernetesApiError)
		expect(cause.transport).toBe('connect')
		expect(cause.status).toBeUndefined()
	})

	it('names a server that accepts and never answers as api-timeout', async () => {
		server = await startFakeApiServer(async (req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'DELETE') return { status: 200, body: {} }
			// Never resolves inside the test; the client's own bound ends it.
			await new Promise<void>(() => {})
			return { status: 200, body: {} }
		})

		const error = acquireError(
			await refusal(
				backend({ readyTimeoutMs: 2_500, apiRequestTimeoutMs: 1_000 }).create({
					workingDirectory: '/workspace',
				}),
			),
		)

		expect(error.reason).toBe('api-timeout')
		expect(error.retryable).toBe(true)
		// The two clocks stay distinguishable at the call site: the acquire
		// names the diagnosis, the poll's give-up is underneath it, and the
		// request bound that actually expired is underneath that.
		const pollTimeout = error.cause as ReadinessPollTimeout
		expect(pollTimeout).toBeInstanceOf(ReadinessPollTimeout)
		expect(pollTimeout.cause).toBeInstanceOf(KubernetesApiTimeoutError)
		// Retried: the 1 s bound expired more than once inside a 2.5 s budget.
		expect(server.matching('GET', '/sandboxclaims/').length).toBeGreaterThan(1)
	})
})

describe('the acquire that succeeds', () => {
	it('issues exactly the requests it issued before any of this', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: READY_CLAIM }
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: READY_POD }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		// The baseline: create, read the claim once, read the pod once. The
		// classification, the retry hook and the pod diagnosis all cost this
		// path nothing, and a future change that adds a round trip here is a
		// change to the sub-second acquire, which is the whole point of the
		// warm path.
		expect(trace(server.requests)).toEqual([
			`POST /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims`,
			`GET /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims/<name>`,
			`GET /api/v1/namespaces/${NAMESPACE}/pods/${POOL_SANDBOX_NAME}`,
		])
		await sandbox.destroy()
	})
})

describe('the classes a host has to catch', () => {
	it('are all importable from the package root', () => {
		// The point of the whole workstream: a host telling a burst past node
		// capacity from an API outage should name a class, not match a message
		// that any release is free to reword. Every one of these was reachable
		// only through a deep path into `dist/` before, which `package.json`
		// does not export.
		for (const cls of [
			KubernetesAcquireError,
			KubernetesAlreadyGoneError,
			KubernetesApiError,
			KubernetesApiTimeoutError,
			KubernetesConflictError,
			KubernetesCredentialError,
			KubernetesEgressPolicyMismatchError,
			KubernetesEgressPolicyNotAppliedError,
			KubernetesUnenforceableEgressPolicyError,
			ReadinessPollTimeout,
		]) {
			expect(typeof cls).toBe('function')
			expect(Object.create(cls.prototype)).toBeInstanceOf(Error)
		}
		expect(TERMINAL_CLAIM_REASONS).toContain('WarmPoolNotFound')
	})
})
