/**
 * The egress UNION check, end to end: `buildKubernetesBackend(...).create()`
 * and `buildEgressBoundary` against a real fake HTTP API server.
 *
 * `egress-policy.test.ts` covers the translations and the union rule in
 * isolation, one shape per case; `egress-verification.test.ts` covers the
 * named-object check under the `verify: 'named-object-only'` opt-out. This
 * file is the "does the backend actually do it" half: that a second policy
 * selecting the sandbox pods stops a create BEFORE a sandbox is handed back,
 * that a refusal leaves no claim and no Sandbox, that the pass is cached per
 * label set and expires, and that the opt-out issues exactly the one request
 * it always did.
 *
 * What NONE of this proves is enforcement. kind has no Cilium data plane and
 * kindnet does not enforce `NetworkPolicy` at all, so a "the connection was
 * blocked" probe there passes for the wrong reason. The live criteria — a
 * `no-network` sandbox failing to resolve a name and failing a TCP connect
 * while `exec` keeps working; a `public-internet` sandbox reaching a public
 * host and failing against the metadata address, the platform endpoint, a
 * private address, the API server's service IP and another sandbox pod —
 * need a cluster that enforces, run with a positive control. See
 * `docs/sdk/kubernetes-sandbox.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { KubernetesEgressPolicyUnionError } from '../egress-policy.js'
import { EGRESS_UNION_CACHE_TTL_MS, buildEgressBoundary, buildKubernetesBackend } from '../index.js'
import { createKubernetesClient } from '../k8s-client.js'
import {
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const POOL_SANDBOX_NAME = 'egress-union-sandbox-1'
const POD_UID = '5f2c9c9c-0e5d-4a2d-9e2a-19b1c0a8d0e5'
const TEMPLATE_LABEL = { 'sandbox.namzu.ai/template': 'namzu-task' }

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

/** The spec a `deny-all` translation against `namzu-task` produces. */
const DENY_ALL_SPEC = {
	podSelector: { matchLabels: TEMPLATE_LABEL },
	policyTypes: ['Egress'],
	egress: [
		{
			to: [
				{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
			],
			ports: [
				{ protocol: 'UDP', port: 53 },
				{ protocol: 'TCP', port: 53 },
			],
		},
	],
}

/** The spec a `no-network` translation produces: egress-scoped, no rule. */
const NO_NETWORK_SPEC = {
	podSelector: { matchLabels: TEMPLATE_LABEL },
	policyTypes: ['Egress'],
	egress: [],
}

function namedPolicy(spec: Record<string, unknown>): Record<string, unknown> {
	return { metadata: { name: 'namzu-task-egress', namespace: NAMESPACE }, spec }
}

/** The pool's acquire path, with pod labels — what a policy selector matches. */
function handleWarmAcquire(req: RecordedRequest): { status: number; body: unknown } | undefined {
	if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
		return { status: 201, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
		return {
			status: 200,
			body: {
				status: {
					conditions: [readyCondition()],
					sandbox: {
						name: POOL_SANDBOX_NAME,
						serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
					},
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		return { status: 200, body: { metadata: { uid: POD_UID, labels: TEMPLATE_LABEL } } }
	}
	if (req.method === 'DELETE') return { status: 200, body: {} }
	return undefined
}

interface ClusterPolicies {
	readonly named: Record<string, unknown>
	readonly items: readonly Record<string, unknown>[]
}

function clusterServer(policies: ClusterPolicies): Promise<FakeApiServer> {
	return startFakeApiServer((req) => {
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 200, body: policies.named }
		}
		if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
			return { status: 200, body: { items: policies.items } }
		}
		return handleWarmAcquire(req) ?? { status: 404, body: {} }
	})
}

function backend(
	egress: Record<string, unknown> = { policy: { kind: 'deny-all' } },
): ReturnType<typeof buildKubernetesBackend> {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		egress: egress as never,
	})
}

describe('a second policy selecting the sandbox pods', () => {
	it('lets a create through when the applied policy is the only one that selects them', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [namedPolicy(DENY_ALL_SPEC)],
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		// Both halves ran: one GET by name, one enumeration of the collection.
		expect(server.matching('GET', '/networkpolicies/namzu-task-egress')).toHaveLength(1)
		expect(
			server.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/networkpolicies')),
		).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses, and names it, when one of them allows everything', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [
				namedPolicy(DENY_ALL_SPEC),
				{
					metadata: { name: 'debug-egress' },
					spec: {
						podSelector: { matchLabels: TEMPLATE_LABEL },
						policyTypes: ['Egress'],
						egress: [{}],
					},
				},
			],
		})

		const failure = await backend()
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		const union = failure as KubernetesEgressPolicyUnionError
		expect(union.refusal).toBe('policy-widens-egress')
		expect(union.message).toContain('NetworkPolicy/debug-egress')
		// The pod's own labels, and every policy examined with a verdict each —
		// the operator's whole debugging session, in the message.
		expect(union.message).toContain('sandbox.namzu.ai/template=namzu-task')
		expect(union.message).toContain('namzu-task-egress: within')
		expect(union.podLabels).toEqual(TEMPLATE_LABEL)
	})

	it('leaves no claim and no Sandbox behind when it refuses', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [
				namedPolicy(DENY_ALL_SPEC),
				{
					metadata: { name: 'debug-egress' },
					spec: {
						podSelector: { matchLabels: TEMPLATE_LABEL },
						policyTypes: ['Egress'],
						egress: [{}],
					},
				},
			],
		})

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toBeInstanceOf(
			KubernetesEgressPolicyUnionError,
		)
		// The claim this create POSTed is deleted through the acquire path's own
		// cleanup — the same path a refused privilege probe takes.
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
		expect(server.matching('POST', '/sandboxes')).toHaveLength(0)
	})

	it('ignores one whose selector does not match the pod', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [
				namedPolicy(DENY_ALL_SPEC),
				{
					metadata: { name: 'other-workload-egress' },
					spec: {
						podSelector: { matchLabels: { app: 'billing' } },
						policyTypes: ['Egress'],
						egress: [{}],
					},
				},
			],
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		await sandbox.destroy()
	})

	it("refuses a template-managed policy that allows DNS when 'no-network' is configured", async () => {
		// This is the shape a SandboxTemplate's own `networkPolicy` block
		// becomes: the controller translates it into a policy of its own, which
		// does not sit "underneath" anything — it unions with everything else.
		server = await clusterServer({
			named: namedPolicy(NO_NETWORK_SPEC),
			items: [
				namedPolicy(NO_NETWORK_SPEC),
				{
					metadata: { name: 'namzu-task-managed' },
					spec: {
						podSelector: { matchLabels: TEMPLATE_LABEL },
						policyTypes: ['Egress'],
						egress: [
							{
								to: [
									{
										namespaceSelector: {
											matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
										},
										podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
									},
								],
								ports: [{ protocol: 'UDP', port: 53 }],
							},
						],
					},
				},
			],
		})

		const failure = await backend({ policy: { kind: 'no-network' } })
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		expect((failure as Error).message).toContain('NetworkPolicy/namzu-task-managed')
		expect((failure as Error).message).toContain('permits no egress at all')
	})

	it('refuses when nothing in the namespace default-denies egress on this pod', async () => {
		// The named object verifies — it exists and matches exactly — but its
		// podSelector matches labels this pod does not carry, so nothing bounds
		// what the pod sends. That is the failure the single-object check could
		// not see.
		server = await clusterServer({ named: namedPolicy(DENY_ALL_SPEC), items: [] })

		const failure = await backend()
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		expect((failure as KubernetesEgressPolicyUnionError).refusal).toBe('no-enforcing-policy')
	})

	it('reports a collection it could not list rather than an empty namespace', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: namedPolicy(DENY_ALL_SPEC) }
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 403, body: { message: 'networkpolicies is forbidden' } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		const failure = await backend()
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		const union = failure as KubernetesEgressPolicyUnionError
		expect(union.refusal).toBe('not-evaluable')
		expect(union.unread).toHaveLength(1)
		expect(union.unread[0]?.why).toBe('forbidden')
		expect(union.message).toContain("egress.verify: 'named-object-only'")
	})
})

describe('a pool-less create, whose labels are known before anything exists', () => {
	/** The template a pool-less create copies a podTemplate out of. */
	const TEMPLATE_REPLY = {
		metadata: { name: 'namzu-task', namespace: NAMESPACE },
		spec: { podTemplate: { spec: { containers: [{ name: 'main', image: 'namzu/agent:test' }] } } },
	}

	it('refuses before the POST, so no Sandbox and no PVC is created', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: TEMPLATE_REPLY }
			}
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: namedPolicy(DENY_ALL_SPEC) }
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return {
					status: 200,
					body: {
						items: [
							namedPolicy(DENY_ALL_SPEC),
							{
								metadata: { name: 'debug-egress' },
								spec: {
									podSelector: { matchLabels: TEMPLATE_LABEL },
									policyTypes: ['Egress'],
									egress: [{}],
								},
							},
						],
					},
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		if (!agent) throw new Error('fixtures not started')
		const provider = buildKubernetesBackend({
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-task',
			agentPort: agent.port,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
			egress: { policy: { kind: 'deny-all' } },
		})

		await expect(provider.create({ workingDirectory: '/workspace' })).rejects.toBeInstanceOf(
			KubernetesEgressPolicyUnionError,
		)
		// The labels checked are the ones `buildSandboxBody` WOULD have
		// stamped, so nothing had to be created to find out.
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})
})

describe("verify: 'named-object-only'", () => {
	it('issues exactly the one request the check issued before the union existed', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: namedPolicy(DENY_ALL_SPEC) }
			}
			// A collection GET would 404 here: the point is that none is sent.
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		const provider = backend({ policy: { kind: 'deny-all' }, verify: 'named-object-only' })
		const first = await provider.create({ workingDirectory: '/workspace' })
		const second = await provider.create({ workingDirectory: '/workspace' })

		expect(server.matching('GET', '/networkpolicies/namzu-task-egress')).toHaveLength(1)
		expect(
			server.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/networkpolicies')),
		).toHaveLength(0)
		await first.destroy()
		await second.destroy()
	})
})

describe('the union cache', () => {
	/** A boundary over the fake server, with a clock the test owns. */
	function boundaryOver(now: () => number) {
		if (!server) throw new Error('fixtures not started')
		const client = createKubernetesClient({
			server: server.url,
			namespace: NAMESPACE,
			getToken: async () => 'sa-token',
		})
		return buildEgressBoundary(
			client,
			{
				access: { server: server.url, getToken: async () => 'sa-token' },
				namespace: NAMESPACE,
				sandboxTemplateName: 'namzu-task',
				egress: { policy: { kind: 'deny-all' } },
			},
			'namzu-task',
			now,
		)
	}

	function enumerations(): number {
		return (
			server?.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/networkpolicies'))
				.length ?? 0
		)
	}

	it('is keyed by label set, and expires within five minutes', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [namedPolicy(DENY_ALL_SPEC)],
		})
		let clock = 1_000
		const boundary = boundaryOver(() => clock)
		if (boundary === undefined) throw new Error('no boundary')

		await boundary.verifyUnion(TEMPLATE_LABEL, 'first')
		await boundary.verifyUnion(TEMPLATE_LABEL, 'second')
		expect(enumerations()).toBe(1)

		// A different pod — a pooled sandbox's labels come off the pool's
		// template, so one memo would answer for a pod it never examined.
		await boundary.verifyUnion({ ...TEMPLATE_LABEL, app: 'other' }, 'third')
		expect(enumerations()).toBe(2)

		// Same labels, five minutes later: read again, because an operator who
		// applies a widening policy at 10:00 should not go unnoticed until the
		// host restarts.
		clock += EGRESS_UNION_CACHE_TTL_MS + 1
		await boundary.verifyUnion(TEMPLATE_LABEL, 'fourth')
		expect(enumerations()).toBe(3)
	})

	it('never caches a failure', async () => {
		server = await clusterServer({
			named: namedPolicy(DENY_ALL_SPEC),
			items: [
				{
					metadata: { name: 'debug-egress' },
					spec: {
						podSelector: { matchLabels: TEMPLATE_LABEL },
						policyTypes: ['Egress'],
						egress: [{}],
					},
				},
			],
		})
		const boundary = boundaryOver(() => 1_000)
		if (boundary === undefined) throw new Error('no boundary')

		await expect(boundary.verifyUnion(TEMPLATE_LABEL, 'first')).rejects.toBeInstanceOf(
			KubernetesEgressPolicyUnionError,
		)
		await expect(boundary.verifyUnion(TEMPLATE_LABEL, 'second')).rejects.toBeInstanceOf(
			KubernetesEgressPolicyUnionError,
		)
		// Fixing the cluster and calling again must retry, so the second call
		// reads the collection again rather than replaying the rejection.
		expect(enumerations()).toBe(2)
	})
})
