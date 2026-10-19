/**
 * #499 — `setNetworkPolicy` on a kubernetes sandbox: one claim-owned
 * `CiliumNetworkPolicy` per live sandbox, behind an admission fence.
 *
 * Everything here runs against the fake API server, because everything here
 * is about REQUESTS: which ones are sent, in which order, with exactly what
 * body, and — for every refusal — that none is sent at all.
 *
 * WHAT A LOCAL SINGLE-NODE CLUSTER PROVED, AND THIS FILE CANNOT FABRICATE
 * (kind-namzu, Kubernetes v1.37.0, the upstream `CiliumNetworkPolicy` CRD
 * (cilium v1.16.5) installed WITHOUT any data plane, this repo's
 * `k8s/manifests/rbac.yaml` + `rbac-per-sandbox-egress.yaml` +
 * `validatingadmissionpolicy-cilium.yaml` applied verbatim, every write
 * issued as the host ServiceAccount through impersonation):
 *  - the exact body {@link buildCiliumEgressManifest} produces here is
 *    ADMITTED, and a merge `PATCH` replacing its `spec.egress` is admitted
 *    too — the two writes this backend issues;
 *  - the fence REFUSES, with the host holding create/patch/delete on the
 *    whole resource: a name without the `namzu-sbx-` prefix, a name whose
 *    suffix is not the owner reference's uid, a policy with no owner
 *    reference, an owner of a foreign kind, `blockOwnerDeletion: true`, a
 *    two-label `endpointSelector`, a `matchExpressions` one, a ONE-label
 *    selector whose value is the shared template label or another sandbox's
 *    name, `toFQDNs: [{matchPattern: '*'}]`, `'*.*'`, `'*.com'`, an empty
 *    `toFQDNs` list, the kube-dns rule moved to port 443,
 *    `toEntities: ['world']`, `toCIDR`, an `ingress` rule, a `specs` list
 *    (the CRD's alternative to `spec`, which a fence reading only `spec`
 *    would be walked straight past by), a widening `PATCH` of the host's own
 *    policy — by peer kind, by `toFQDNs` pattern and by selector — and a
 *    `DELETE` of the operator's baseline policy, while its own policy's
 *    `DELETE` and its replacement merge-`PATCH` are both admitted;
 *  - 51 claims each got their own policy, written concurrently: 51 distinct
 *    names, 51 distinct selectors, 51 distinct owner uids, no cross-writes;
 *  - GARBAGE COLLECTION is real: deleting one claim removed exactly its
 *    policy 88 ms after the DELETE returned, deleting all of them removed
 *    all 51, and the operator's own unowned policy survived every one;
 *  - RBAC: a host bound to the DEFAULT Role alone can `get` and `list`
 *    policies and cannot `create`, `patch` or `delete` one, and cannot read
 *    the admission policy either; the opt-in Role adds exactly those three
 *    verbs plus the cluster-scoped `get`; neither can CREATE a
 *    `ValidatingAdmissionPolicy`.
 *
 * WHAT NOTHING ANYWHERE IN THIS REPOSITORY PROVES: that any of it is
 * ENFORCED. Enforcement is one CNI's data plane and no cluster available
 * here runs one, so the issue's "the registry answers and example.com does
 * not, for 50 concurrent sandboxes with 50 different lists" is UNPROVEN —
 * it needs a real Cilium cluster and a positive control (an allowed host
 * that still answers), exactly as the egress and profile suites already say
 * of their own kinds.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Sandbox } from '@namzu/sdk'

import {
	DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY,
	KubernetesEgressPolicyUnionError,
	KubernetesPerSandboxEgressConfigError,
	PER_SANDBOX_NARROWING_REFUSAL,
	buildCiliumEgressManifest,
	composeAdditionalPodLabels,
} from '../egress-policy.js'
import { type KubernetesBackendInternalConfig, buildKubernetesBackend } from '../index.js'
import {
	KubernetesAdmissionFenceInertError,
	KubernetesAdmissionFenceMissingError,
	KubernetesAdmissionFenceUnreadableError,
	KubernetesNetworkPolicyHostError,
	KubernetesOwnerUidMissingError,
	KubernetesPerSandboxPolicyNotRemovedError,
	KubernetesPermittedHostsError,
	KubernetesPermittedHostsParamError,
	PER_SANDBOX_POLICY_NAME_PREFIX,
	perSandboxPolicyName,
	perSandboxPolicyOwnerReference,
} from '../per-sandbox-policy.js'
import {
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { type FenceObjects, shippedFence, specOf } from './fixtures/fence-objects.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const TEMPLATE = 'namzu-task'
const POOL = 'namzu-task-pool'
const POD_UID = '7c1d9a2e-4b55-4a0e-9c3f-2f10b7a54321'
const TEMPLATE_LABEL = { 'sandbox.namzu.ai/template': TEMPLATE } as const
const ADMISSION_POLICY = 'namzu-per-sandbox-egress'
const LABEL_KEY = DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY

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

/** `deny-all`'s translated egress — the configured BASELINE, unchanged here. */
const DENY_ALL_EGRESS = [
	{
		to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
		ports: [
			{ protocol: 'UDP', port: 53 },
			{ protocol: 'TCP', port: 53 },
		],
	},
]

const BASELINE_POLICY = {
	metadata: { name: `${TEMPLATE}-egress`, namespace: NAMESPACE },
	spec: {
		podSelector: { matchLabels: TEMPLATE_LABEL },
		policyTypes: ['Egress'],
		egress: DENY_ALL_EGRESS,
	},
}

interface ClusterOptions {
	/**
	 * Omit the admission policy, its binding, or neither — or answer the
	 * policy read with a 403, which is what the namespaced Role WITHOUT the
	 * cluster-scoped one in the same file produces.
	 */
	readonly fence?: 'both' | 'no-policy' | 'no-binding' | 'unreadable' | 'no-companion-policy'
	/** Answer a DELETE of a per-sandbox policy with this status instead of deleting it. */
	readonly deleteStatus?: number
	/** The operator's baseline object. Defaults to `deny-all`'s. */
	readonly baseline?: Record<string, unknown>
	/** What a read-back of a written per-sandbox policy answers with. */
	readonly readBack?: (written: Record<string, unknown>) => unknown
	/** Claim uid per claim name. Defaults to a name-derived uid. */
	readonly uidFor?: (claimName: string) => string
	/** Drop the per-sandbox label from the bound pod. */
	readonly unlabelledPod?: boolean
}

function uidFromName(name: string): string {
	// A shape a uid actually has, derived from the name so a suite with fifty
	// sandboxes in flight can predict each one's policy name.
	const tail = name.slice(-12).padStart(12, '0')
	return `00000000-0000-4000-8000-${tail}`
}

/** The policies this cluster is holding, keyed by name — the writes, as applied. */
type PolicyStore = Map<string, Record<string, unknown>>

async function startCluster(options: ClusterOptions = {}): Promise<{
	server: FakeApiServer
	policies: PolicyStore
	/** The admission objects as the cluster holds them; a test edits these live. */
	fence: FenceObjects
	/** Further CiliumNetworkPolicies in the namespace, listed beside this host's own. */
	others: Record<string, unknown>[]
	/** The permitted-hosts ConfigMap; `undefined` answers 404, `'forbidden'` 403. */
	param: { current: Record<string, unknown> | undefined | 'forbidden' }
}> {
	const policies: PolicyStore = new Map()
	const fenceObjects = shippedFence()
	const others: Record<string, unknown>[] = []
	const param: { current: Record<string, unknown> | undefined | 'forbidden' } = {
		current: fenceObjects.configMap,
	}
	const uidFor = options.uidFor ?? uidFromName
	const fence = options.fence ?? 'both'
	const api = await startFakeApiServer((req: RecordedRequest) => {
		// The admission fence, read before the first write.
		if (req.path.includes('/validatingadmissionpolicybindings/')) {
			if (req.path.endsWith('-hosts-binding'))
				return { status: 200, body: fenceObjects.companionBinding }
			return fence === 'no-binding'
				? { status: 404, body: {} }
				: { status: 200, body: fenceObjects.binding }
		}
		if (req.path.includes('/validatingadmissionpolicies/')) {
			if (req.path.endsWith('-hosts')) {
				return fence === 'no-companion-policy'
					? { status: 404, body: {} }
					: { status: 200, body: fenceObjects.companionPolicy }
			}
			if (fence === 'no-policy') return { status: 404, body: {} }
			if (fence === 'unreadable') return { status: 403, body: {} }
			return { status: 200, body: fenceObjects.policy }
		}
		if (req.path.includes('/configmaps/')) {
			if (param.current === 'forbidden') return { status: 403, body: {} }
			return param.current === undefined
				? { status: 404, body: {} }
				: { status: 200, body: param.current }
		}
		// The per-sandbox policies this backend writes.
		if (req.path.includes('/ciliumnetworkpolicies')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
			if (req.method === 'GET' && name === 'ciliumnetworkpolicies') {
				return { status: 200, body: { items: [...policies.values(), ...others] } }
			}
			if (req.method === 'POST') {
				const body = req.body as Record<string, unknown>
				const written = (body.metadata as { name: string }).name
				if (policies.has(written)) return { status: 409, body: {} }
				policies.set(written, body)
				return { status: 201, body }
			}
			if (req.method === 'PATCH') {
				const current = policies.get(name)
				if (current === undefined) return { status: 404, body: {} }
				const body = req.body as Record<string, unknown>
				policies.set(name, { ...current, ...body })
				return { status: 200, body: policies.get(name) }
			}
			if (req.method === 'DELETE') {
				if (options.deleteStatus !== undefined) return { status: options.deleteStatus, body: {} }
				const existed = policies.delete(name)
				return existed ? { status: 200, body: {} } : { status: 404, body: {} }
			}
			const stored = policies.get(name)
			if (stored === undefined) return { status: 404, body: {} }
			return { status: 200, body: options.readBack?.(stored) ?? stored }
		}
		// The configured BASELINE — the named-object check and the union check.
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 200, body: options.baseline ?? BASELINE_POLICY }
		}
		if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
			return { status: 200, body: { items: [options.baseline ?? BASELINE_POLICY] } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
			const body = req.body as { metadata: { name: string } }
			return {
				status: 201,
				body: { metadata: { name: body.metadata.name, uid: uidFor(body.metadata.name) } },
			}
		}
		if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
			return {
				status: 200,
				body: {
					metadata: { name, uid: uidFor(name) },
					status: {
						conditions: [readyCondition()],
						// Bound sandbox named after the claim, so a pod read can
						// answer with that sandbox's own labels.
						sandbox: { name, serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local` },
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
			return {
				status: 200,
				body: {
					metadata: {
						uid: POD_UID,
						labels: {
							...TEMPLATE_LABEL,
							...(options.unlabelledPod === true ? {} : { [LABEL_KEY]: name }),
						},
					},
				},
			}
		}
		if (req.method === 'DELETE') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})
	return { server: api, policies, fence: fenceObjects, others, param }
}

function config(
	extra: Partial<KubernetesBackendInternalConfig> = {},
): KubernetesBackendInternalConfig {
	if (!server || !agent) throw new Error('fixtures not started')
	return {
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TEMPLATE,
		warmPoolName: POOL,
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		// This suite is about egress, not the agent port — same opt-out every
		// other acquire fixture in this directory uses.
		ingress: 'unverified' as const,
		egress: {
			policy: { kind: 'deny-all' },
			perSandbox: { engine: 'cilium' as const, admissionPolicyName: ADMISSION_POLICY },
		},
		...extra,
	}
}

/** Every write this backend could send to a policy object. */
function policyWrites(api: FakeApiServer): readonly RecordedRequest[] {
	return api.requests.filter((r) => r.path.includes('/ciliumnetworkpolicies') && r.method !== 'GET')
}

async function acquire(
	cfg: KubernetesBackendInternalConfig = config(),
): Promise<Sandbox & { setNetworkPolicy?: Sandbox['setNetworkPolicy'] }> {
	return await buildKubernetesBackend(cfg).create({ workingDirectory: '/workspace' })
}

describe('presence follows configuration', () => {
	it('omits setNetworkPolicy when egress.perSandbox is unset, and issues no policy write', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire(config({ egress: { policy: { kind: 'deny-all' } } }))

		expect(sandbox.setNetworkPolicy).toBeUndefined()
		expect(policyWrites(server)).toHaveLength(0)
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(0)
		await sandbox.destroy()
	})

	it('adds it when perSandbox is configured', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		expect(typeof sandbox.setNetworkPolicy).toBe('function')
		// Presence is a fact about configuration, not about the cluster: no
		// fence read, and no policy write, happens until the method is called.
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(0)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it("refuses engine: 'core' synchronously, while the host is still being wired", async () => {
		const started = await startCluster()
		server = started.server

		expect(() =>
			buildKubernetesBackend(
				config({
					egress: {
						policy: { kind: 'deny-all' },
						perSandbox: { engine: 'core', admissionPolicyName: ADMISSION_POLICY },
					},
				}),
			),
		).toThrow(KubernetesPerSandboxEgressConfigError)
		expect(server.requests).toHaveLength(0)
	})

	it('refuses a selector key that would collide with a label this backend already writes', async () => {
		const started = await startCluster()
		server = started.server

		expect(() =>
			buildKubernetesBackend(
				config({
					egress: {
						policy: { kind: 'deny-all' },
						perSandbox: {
							engine: 'cilium',
							admissionPolicyName: ADMISSION_POLICY,
							labelKey: 'sandbox.namzu.ai/template',
						},
					},
				}),
			),
		).toThrow(KubernetesPerSandboxEgressConfigError)
	})
})

describe('the per-sandbox selector label', () => {
	it('rides on the SAME claim-time pod-label map, from the one composer', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		const posted = server.matching('POST', '/sandboxclaims')
		expect(posted).toHaveLength(1)
		const body = posted[0]?.body as { metadata: { name: string }; spec: Record<string, unknown> }
		const claimName = body.metadata.name
		expect(body.spec.additionalPodMetadata).toEqual({ labels: { [LABEL_KEY]: claimName } })
		// The same map the composer produces for this config, with the label
		// as an `extra` key rather than a second construction.
		expect(body.spec.additionalPodMetadata).toEqual({
			labels: composeAdditionalPodLabels(
				{ policy: { kind: 'deny-all' } },
				{ [LABEL_KEY]: claimName },
			),
		})
		await sandbox.destroy()
	})

	it('refuses the ACQUIRE when the created object reported no uid', async () => {
		// The uid is the policy's name suffix and its owner reference. Without
		// it there is no policy to write that the cluster would ever collect,
		// so the acquire fails by class rather than handing back a sandbox
		// whose setNetworkPolicy would write an orphan.
		const started = await startCluster({ uidFor: () => '' })
		server = started.server

		const failure = await acquire().catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesOwnerUidMissingError)
		expect(policyWrites(server)).toHaveLength(0)
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
	})

	it('refuses a bound pod that never carried it, and hands nothing back', async () => {
		const started = await startCluster({ unlabelledPod: true })
		server = started.server

		const failure = await acquire().catch((err: unknown) => err)

		// W21's refusal, reached through the same wait: a pod without the
		// label is selected by no per-sandbox policy, so admitting it would
		// run the sandbox under whatever policy DOES select it.
		expect((failure as Error).message).toContain(LABEL_KEY)
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
	})
})

describe('what a write puts on the cluster', () => {
	it('is one CiliumNetworkPolicy named after the claim uid, owned by the claim', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		const claimName = (
			server.matching('POST', '/sandboxclaims')[0]?.body as { metadata: { name: string } }
		).metadata.name
		const uid = uidFromName(claimName)

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org', '.example.com'] })

		const writes = policyWrites(server)
		expect(writes).toHaveLength(1)
		expect(writes[0]?.method).toBe('POST')
		expect(writes[0]?.body).toEqual({
			apiVersion: 'cilium.io/v2',
			kind: 'CiliumNetworkPolicy',
			metadata: {
				name: `${PER_SANDBOX_POLICY_NAME_PREFIX}${uid}`,
				namespace: NAMESPACE,
				ownerReferences: [
					{
						apiVersion: 'extensions.agents.x-k8s.io/v1beta1',
						kind: 'SandboxClaim',
						name: claimName,
						uid,
					},
				],
			},
			spec: {
				endpointSelector: { matchLabels: { [LABEL_KEY]: claimName } },
				egress: [
					{
						toEndpoints: [
							{
								matchLabels: {
									'k8s:io.kubernetes.pod.namespace': 'kube-system',
									'k8s:k8s-app': 'kube-dns',
								},
							},
						],
						toPorts: [
							{ ports: [{ port: '53', protocol: 'ANY' }], rules: { dns: [{ matchPattern: '*' }] } },
						],
					},
					{
						toFQDNs: [
							{ matchName: 'registry.npmjs.org' },
							// `.example.com` is the domain AND its subdomains —
							// `SandboxNetworkPolicy`'s own grammar, and a
							// matchPattern is the only way Cilium spells it.
							{ matchName: 'example.com' },
							{ matchPattern: '*.example.com' },
						],
					},
				],
			},
		})
		// The body is the shared builder's, not a second construction.
		expect(writes[0]?.body).toEqual(
			buildCiliumEgressManifest({
				namespace: NAMESPACE,
				name: perSandboxPolicyName(uid),
				selectorLabels: { [LABEL_KEY]: claimName },
				allowedHosts: ['registry.npmjs.org', '.example.com'],
				policyKind: 'static',
				ownerReferences: [
					perSandboxPolicyOwnerReference({ kind: 'SandboxClaim', name: claimName, uid }),
				],
				refusalContext: PER_SANDBOX_NARROWING_REFUSAL,
			}).manifest,
		)
		await sandbox.destroy()
	})

	it('reads the object back and resolves only once it matches', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })

		const reads = server.requests.filter(
			(r) => r.method === 'GET' && r.path.includes('/ciliumnetworkpolicies/'),
		)
		expect(reads).toHaveLength(1)
		await sandbox.destroy()
	})

	it('rejects, naming what differed, when the cluster holds something else', async () => {
		const started = await startCluster({
			readBack: (written) => ({
				...written,
				spec: {
					...(written.spec as Record<string, unknown>),
					egress: [{ toEntities: ['world'] }],
				},
			}),
		})
		server = started.server
		const sandbox = await acquire()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		expect((failure as Error).name).toBe('KubernetesEgressPolicyMismatchError')
		expect((failure as Error).message).toContain('toEntities')
		await sandbox.destroy()
	})

	it('rejects when the read-back has lost the owner reference', async () => {
		const started = await startCluster({
			readBack: (written) => {
				// Everything the comparator looked at before is untouched: the
				// spec matches exactly and only the ownerReferences are gone,
				// which `spec` cannot show. A policy in that state outlives
				// the sandbox it was written for — the leak the reference is
				// there to prevent.
				const metadata = { ...(written.metadata as Record<string, unknown>) }
				// biome-ignore lint/performance/noDelete: the reference has to be GONE from the object, not present-but-undefined — `ownerReferences: undefined` is not what a dropped owner reference looks like on the wire.
				delete metadata.ownerReferences
				return { ...written, metadata }
			},
		})
		server = started.server
		const sandbox = await acquire()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		expect((failure as Error).name).toBe('KubernetesEgressPolicyMismatchError')
		expect((failure as Error).message).toContain('ownerReferences')
		await sandbox.destroy()
	})

	it('replaces its own policy on a second call, through one PATCH', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['files.example.org'] })

		const writes = policyWrites(server)
		expect(writes.map((w) => w.method)).toEqual(['POST', 'POST', 'PATCH'])
		// A merge patch replaces `spec.egress` wholesale, which is what a
		// REPLACEMENT policy needs — and the stored object proves it rather
		// than the request shape alone.
		const stored = [...started.policies.values()][0] as { spec: { egress: unknown[] } }
		expect(JSON.stringify(stored.spec.egress)).toContain('files.example.org')
		expect(JSON.stringify(stored.spec.egress)).not.toContain('registry.npmjs.org')
		await sandbox.destroy()
	})

	it('is left for the cluster to collect: destroy() deletes no policy of its own', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })

		await sandbox.destroy()

		// The ownerReference is the whole teardown path: DELETE the claim and
		// the cluster's garbage collector removes the policy. A host that
		// deleted its own policies would leak every one it crashed holding.
		expect(policyWrites(server).filter((w) => w.method === 'DELETE')).toHaveLength(0)
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
	})

	it('deletes the object for an empty list, and leaves the baseline in force', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
		await sandbox.setNetworkPolicy?.({ allowedHosts: [] })

		const deletes = policyWrites(server).filter((w) => w.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(started.policies.size).toBe(0)
		// Nothing touched the configured baseline: this backend never writes
		// the named object at all, before or after.
		expect(
			server.requests.filter((r) => r.method !== 'GET' && r.path.includes('/networkpolicies')),
		).toHaveLength(0)
		await sandbox.destroy()
	})

	it('treats an already-collected object as deleted', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		// Never written, so the DELETE meets a 404 — which is the state it was
		// asking for. The cluster may have collected it with the claim while
		// the call was in flight.
		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [] })).resolves.toBeUndefined()
		await sandbox.destroy()
	})
})

describe('the admission fence', () => {
	it('refuses the write, with nothing written, when the policy is missing', async () => {
		const started = await startCluster({ fence: 'no-policy' })
		server = started.server
		const sandbox = await acquire()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		expect((failure as KubernetesAdmissionFenceMissingError).resourceKind).toBe(
			'ValidatingAdmissionPolicy',
		)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('refuses when the BINDING is missing, because an unbound policy validates nothing', async () => {
		const started = await startCluster({ fence: 'no-binding' })
		server = started.server
		const sandbox = await acquire()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		expect((failure as KubernetesAdmissionFenceMissingError).resourceKind).toBe(
			'ValidatingAdmissionPolicyBinding',
		)
		expect((failure as Error).message).toContain(`${ADMISSION_POLICY}-binding`)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('refuses the DELETE too, because the invariant is about writes and not about widening', async () => {
		const started = await startCluster({ fence: 'no-policy' })
		server = started.server
		const sandbox = await acquire()

		// `setNetworkPolicy([])` only ever deletes this sandbox's own object,
		// so it cannot widen anything — but a host that never proved the fence
		// must not reach the namespace's policies with ANY verb it holds, and
		// the shipped ValidatingAdmissionPolicy covers DELETE for exactly that
		// reason. Nothing is sent.
		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: [] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('tells a 403 apart from a missing object, because they are different files to fix', async () => {
		const started = await startCluster({ fence: 'unreadable' })
		server = started.server
		const sandbox = await acquire()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		// The namespaced Role applied without the ClusterRole in the same
		// file: the fence may well be there, and this host may not look. Being
		// told to apply a manifest that is already applied is the wrong
		// errand, so it is its own class and names the RBAC file.
		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceUnreadableError)
		expect((failure as Error).message).toContain('rbac-per-sandbox-egress.yaml')
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('is proved once per backend, not once per call', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] })
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })

		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(1)
		expect(server.matching('GET', '/validatingadmissionpolicybindings/')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('is not memoized when it FAILED, so an operator applying it later gets through', async () => {
		// One handler, two answers: the fence arrives between the two calls.
		let fencePresent = false
		const policies: Map<string, Record<string, unknown>> = new Map()
		server = await startFakeApiServer((req: RecordedRequest) => {
			if (req.path.includes('/validatingadmissionpolic')) {
				if (!fencePresent) return { status: 404, body: {} }
				return {
					status: 200,
					body: req.path.includes('bindings') ? shippedFence().binding : shippedFence().policy,
				}
			}
			if (req.path.includes('/ciliumnetworkpolicies')) {
				if (req.method === 'POST') {
					const body = req.body as { metadata: { name: string } }
					policies.set(body.metadata.name, req.body as Record<string, unknown>)
					return { status: 201, body: req.body }
				}
				const name = req.path.slice(req.path.lastIndexOf('/') + 1)
				if (name === 'ciliumnetworkpolicies') {
					return { status: 200, body: { items: [...policies.values()] } }
				}
				const stored = policies.get(name)
				return stored === undefined ? { status: 404, body: {} } : { status: 200, body: stored }
			}
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: BASELINE_POLICY }
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: [BASELINE_POLICY] } }
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
				const body = req.body as { metadata: { name: string } }
				return {
					status: 201,
					body: { metadata: { name: body.metadata.name, uid: uidFromName(body.metadata.name) } },
				}
			}
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				const name = req.path.slice(req.path.lastIndexOf('/') + 1)
				return {
					status: 200,
					body: {
						metadata: { name, uid: uidFromName(name) },
						status: {
							conditions: [readyCondition()],
							sandbox: { name, serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local` },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				const name = req.path.slice(req.path.lastIndexOf('/') + 1)
				return {
					status: 200,
					body: { metadata: { uid: POD_UID, labels: { ...TEMPLATE_LABEL, [LABEL_KEY]: name } } },
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})
		const sandbox = await acquire()

		await expect(
			sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] }),
		).rejects.toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		fencePresent = true
		await expect(
			sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] }),
		).resolves.toBeUndefined()
		await sandbox.destroy()
	})
})

describe('what the method refuses before it sends anything', () => {
	it('an allowedHosts entry that is not a hostname', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		// The same list the config-level translation refuses — see
		// `egress-policy.test.ts`'s `an unusable allowlist entry is refused on
		// the config-level translation too`, which pins these entries and the
		// reasons from the other side. One grammar, called from the one builder
		// both translations go through, so a caller meets the same refusal
		// whichever config field their list came from.
		for (const entry of [
			'https://example.com',
			'*.example.com',
			'example.com:443',
			'.',
			'',
			// A whole public suffix: the pattern it would emit (`*.com`) is
			// what the shipped fence refuses, so it is refused HERE, by name,
			// rather than as an opaque 403 from the API server.
			'.com',
			// The same entry written without its leading name: a bare dot, and
			// a dot before a name that already carries one.
			'..example.com',
			// A glob is not a hostname, and this translation never emits one:
			// `.domain` is how an allowlist says "and its subdomains".
			'*',
			// An address, not a name. It passes a DNS grammar (digits are
			// legal labels) and matches nothing at all in `toFQDNs`, which
			// reads from outside exactly like a policy that is working.
			'10.0.0.1',
		]) {
			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: ['ok.example.com', entry] }),
			).rejects.toBeInstanceOf(KubernetesNetworkPolicyHostError)
		}
		// Nothing was written for ANY of them — including the entry that was
		// fine, which shares the list with one that was not.
		expect(policyWrites(server)).toHaveLength(0)
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(0)
		await sandbox.destroy()
	})

	it('a call on a sandbox this host already destroyed', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		await sandbox.destroy()

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
			.catch((err: unknown) => err)

		expect((failure as Error).name).toBe('KubernetesSandboxDestroyedError')
		expect((failure as Error).message).toContain('setNetworkPolicy')
		expect(policyWrites(server)).toHaveLength(0)
	})

	it('canonicalises letter case rather than refusing it', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		// DNS names are case-insensitive, Cilium matches what the DNS proxy
		// saw (lowercase), and the docker backend accepts either case — so a
		// list that worked there must not throw here.
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['Registry.NPMjs.org', '.Example.COM'] })

		const stored = [...started.policies.values()][0] as { spec: { egress: unknown[] } }
		const emitted = JSON.stringify(stored.spec.egress)
		expect(emitted).toContain('registry.npmjs.org')
		expect(emitted).toContain('*.example.com')
		expect(emitted).not.toContain('NPM')
		await sandbox.destroy()
	})
})

describe('per-sandbox narrowing', () => {
	function narrowedConfig(): KubernetesBackendInternalConfig {
		return config({
			egress: {
				policy: { kind: 'deny-all' },
				perSandbox: {
					engine: 'cilium',
					admissionPolicyName: ADMISSION_POLICY,
					// W12's options, on the PER-SANDBOX field rather than on
					// `ciliumNarrowing`: that one narrows the single
					// config-level policy, which is only a hostname allowlist
					// at all under a `static`/`resolver` kind, and this
					// deployment's baseline is `deny-all`.
					narrowing: {
						hostPorts: { 'registry.npmjs.org': [443] },
						tlsServerNames: true,
					},
				},
			},
		})
	}

	it('emits the ports and TLS server names the option asks for', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire(narrowedConfig())

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })

		const stored = [...started.policies.values()][0] as { spec: { egress: unknown[] } }
		const hostRule = stored.spec.egress[1] as {
			toFQDNs: unknown[]
			toPorts: { ports: { port: string; protocol: string }[]; serverNames?: string[] }[]
		}
		expect(hostRule.toFQDNs).toEqual([{ matchName: 'registry.npmjs.org' }])
		expect(hostRule.toPorts).toEqual([
			{ ports: [{ port: '443', protocol: 'TCP' }], serverNames: ['registry.npmjs.org'] },
		])
		await sandbox.destroy()
	})

	it('refuses a .domain entry while tlsServerNames is on, and still writes an exact one', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire(narrowedConfig())

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['.example.com'] })
			.catch((err: unknown) => err)

		// A TLS server name is ONE exact SNI value a handshake presents, and
		// the entry expands to `example.com` plus `*.example.com`: `serverNames:
		// ['example.com']` would deny every subdomain the toFQDNs half admits,
		// and the entry as written is not a name any handshake presents at
		// all. Either way the object reads back deep-equal to what was sent
		// and DENIES the domain it claims to allow, so it is refused here with
		// nothing written.
		expect(failure).toBeInstanceOf(KubernetesNetworkPolicyHostError)
		expect((failure as Error).message).toContain('tlsServerNames')
		// The field path is the whole of what a refusal still takes from its
		// caller: this caller set `egress.perSandbox.narrowing` and has no
		// `ciliumNarrowing` in its config at all, so the remedy the message
		// offers only exists if the message names that field. Pinned separately
		// from the wording below, so a change pairing this sentence with the
		// config-level field fails here rather than reading as a correct
		// refusal. The config-level caller's field is pinned in
		// `egress-policy.test.ts`.
		expect((failure as Error).message).toContain('config.egress.perSandbox.narrowing')
		expect((failure as Error).message).not.toContain('config.egress.ciliumNarrowing')
		// ONE sentence, because one entry means one thing: wherever this
		// translation emits the entry it is a name plus a `*.domain` pattern,
		// so the message says so and offers the repair that follows from it.
		// The config-level caller is told the same thing — the same assertion
		// on the same sentence is pinned in `egress-policy.test.ts`.
		expect((failure as Error).message).toContain(
			"this entry becomes a name plus a '*.domain' pattern",
		)
		expect((failure as Error).message).toContain(
			'list the exact hosts, or leave tlsServerNames off for a domain list',
		)
		// The closing grammar is on every refusal, because every translation
		// implements it: `.example.com` really does mean the domain and its
		// subdomains once expanded.
		expect((failure as Error).message).toContain('Entries are hostnames')
		expect(policyWrites(server)).toHaveLength(0)
		// Refused BEFORE the fence read, not merely before the write: the
		// combination is a local contradiction, so it costs no round trip.
		// The translation refuses it again on its own account, which is what
		// covers a caller that is not this one.
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(0)

		// The refusal is the COMBINATION's, not the option's: an exact host
		// under the same narrowing is written as usual.
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['registry.npmjs.org'] })
		expect(policyWrites(server)).toHaveLength(1)
		await sandbox.destroy()
	})

	it('lets the DNS proxy see the search-suffix lookups an expanded entry implies', () => {
		// A guest resolving `a.example.com` tries the cluster search suffixes
		// FIRST under the default `ndots:5`, and a lookup the DNS proxy
		// refuses is not an NXDOMAIN the resolver walks past. The exact-host
		// branch has always emitted `<host>.<suffix>`; an entry that admits
		// subdomains needs the pattern under each suffix for the same reason.
		const manifest = buildCiliumEgressManifest({
			namespace: NAMESPACE,
			name: perSandboxPolicyName('uid'),
			selectorLabels: { [LABEL_KEY]: 'claim-1' },
			allowedHosts: ['.example.com'],
			policyKind: 'static',
			narrowing: { dnsNames: true },
			refusalContext: PER_SANDBOX_NARROWING_REFUSAL,
		}).manifest as {
			spec: { egress: { toPorts: { rules: { dns: Record<string, string>[] } }[] }[] }
		}
		const names = manifest.spec.egress[0]?.toPorts[0]?.rules.dns

		expect(names).toContainEqual({ matchName: 'example.com' })
		expect(names).toContainEqual({ matchPattern: '*.example.com' })
		expect(names).toContainEqual({ matchName: `example.com.${NAMESPACE}.svc.cluster.local` })
		expect(names).toContainEqual({
			matchPattern: `*.example.com.${NAMESPACE}.svc.cluster.local`,
		})
	})

	it('is refused during wiring when it names something this backend cannot emit', async () => {
		const started = await startCluster()
		server = started.server

		// The SAME validator the config-level field uses, told which field
		// path it is checking, so the refusal names `perSandbox.narrowing`
		// rather than `ciliumNarrowing`.
		const failure = (() => {
			try {
				buildKubernetesBackend(
					config({
						egress: {
							policy: { kind: 'deny-all' },
							perSandbox: {
								engine: 'cilium',
								admissionPolicyName: ADMISSION_POLICY,
								narrowing: { hostPorts: { 'registry.npmjs.org': [0] } },
							},
						},
					}),
				)
				return undefined
			} catch (err: unknown) {
				return err
			}
		})()

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain('perSandbox.narrowing')
		expect(server.requests).toHaveLength(0)
	})
})

describe('the network-verification memos', () => {
	it('are not defeated by the per-sandbox label, and do not grow per acquire', async () => {
		// The per-sandbox selector label's VALUE is unique per acquire. Both
		// verification memos are keyed on a pod's label set, so carrying that
		// value into the key would turn a once-per-backend namespace-wide
		// policy enumeration into one per sandbox — and leave an entry behind
		// that nothing ever looks up again. The key excludes it; the CHECK
		// still runs over the full label set.
		const started = await startCluster()
		server = started.server
		const backend = buildKubernetesBackend(config())

		const sandboxes = await Promise.all(
			Array.from(
				{ length: 12 },
				async () => await backend.create({ workingDirectory: '/workspace' }),
			),
		)

		// One enumeration for twelve sandboxes, inside the TTL window.
		const enumerations = server.requests.filter(
			(r) => r.method === 'GET' && r.path.endsWith('/networkpolicies'),
		)
		expect(enumerations).toHaveLength(1)
		// Every pod really did carry its own label — the memo key ignores it,
		// the pod does not.
		const claims = server.matching('POST', '/sandboxclaims')
		const labelled = new Set(
			claims.map((c) => {
				const body = c.body as {
					spec: { additionalPodMetadata: { labels: Record<string, string> } }
				}
				return body.spec.additionalPodMetadata.labels[LABEL_KEY]
			}),
		)
		expect(labelled.size).toBe(12)

		await Promise.all(sandboxes.map(async (sandbox) => await sandbox.destroy()))
	})
})

describe('fifty sandboxes at once', () => {
	it('write fifty distinct policies and never touch each other', async () => {
		const started = await startCluster()
		server = started.server
		const backend = buildKubernetesBackend(config())

		const sandboxes = await Promise.all(
			Array.from(
				{ length: 50 },
				async () => await backend.create({ workingDirectory: '/workspace' }),
			),
		)
		await Promise.all(
			sandboxes.map(
				async (sandbox, index) =>
					await sandbox.setNetworkPolicy?.({ allowedHosts: [`host-${index}.example.com`] }),
			),
		)

		expect(started.policies.size).toBe(50)
		const names = new Set<string>()
		const selectors = new Set<string>()
		const owners = new Set<string>()
		for (const [name, policy] of started.policies) {
			names.add(name)
			expect(name.startsWith(PER_SANDBOX_POLICY_NAME_PREFIX)).toBe(true)
			const metadata = policy.metadata as {
				ownerReferences: readonly { kind: string; uid: string; name: string }[]
			}
			expect(metadata.ownerReferences).toHaveLength(1)
			const owner = metadata.ownerReferences[0]
			expect(owner?.kind).toBe('SandboxClaim')
			// The name IS the owner's uid, which is what the shipped admission
			// policy checks — a host cannot write a policy for an object it
			// does not hold.
			expect(name).toBe(perSandboxPolicyName(owner?.uid ?? ''))
			owners.add(owner?.uid ?? '')
			const spec = policy.spec as { endpointSelector: { matchLabels: Record<string, string> } }
			expect(Object.keys(spec.endpointSelector.matchLabels)).toHaveLength(1)
			expect(spec.endpointSelector.matchLabels[LABEL_KEY]).toBe(owner?.name)
			selectors.add(JSON.stringify(spec.endpointSelector))
		}
		expect(names.size).toBe(50)
		expect(selectors.size).toBe(50)
		expect(owners.size).toBe(50)
		// Every allowlist reached its own object: fifty distinct host lists,
		// fifty policies, no cross-writes.
		const hosts = new Set(
			[...started.policies.values()].map((policy) =>
				JSON.stringify((policy.spec as { egress: unknown[] }).egress[1]),
			),
		)
		expect(hosts.size).toBe(50)
		// Fifty writes, and one fence proof shared by all of them.
		expect(policyWrites(server).filter((w) => w.method === 'POST')).toHaveLength(50)
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(1)

		await Promise.all(sandboxes.map(async (sandbox) => await sandbox.destroy()))
	})
})

// ---------------------------------------------------------------------------
// #617 — the per-sandbox path verified as strictly as the `no-network` baseline
// ---------------------------------------------------------------------------
//
// What these prove, and what they cannot: the CONTENT of the fence objects is
// compared field by field, the permitted-hosts parameter is read and enforced
// locally, and the union of the policies selecting the pod is re-checked after
// every write. What they do not prove is that any of it is ENFORCED by a data
// plane, or that the companion policy's CEL refuses what it claims against a
// real API server; see `k8s/scripts/per-sandbox-egress-check.mjs`.

function perSandboxConfig(
	perSandbox: Record<string, unknown> = {},
	egress: Record<string, unknown> = {},
): KubernetesBackendInternalConfig {
	return config({
		egress: {
			policy: { kind: 'deny-all' },
			...egress,
			perSandbox: {
				engine: 'cilium' as const,
				admissionPolicyName: ADMISSION_POLICY,
				...perSandbox,
			},
		},
	})
}

const REGISTRY = 'registry.npmjs.org'

describe('the fence is verified by content, not by existence (#617)', () => {
	type Edit = (fence: FenceObjects) => void
	const refusals: ReadonlyArray<readonly [string, string, Edit]> = [
		[
			'an Audit-only binding',
			'spec.validationActions',
			(f) => {
				specOf(f.binding).validationActions = ['Audit']
			},
		],
		[
			'a Warn-only binding',
			'spec.validationActions',
			(f) => {
				specOf(f.binding).validationActions = ['Warn']
			},
		],
		[
			'a binding that names another policy',
			'spec.policyName',
			(f) => {
				specOf(f.binding).policyName = 'some-other-policy'
			},
		],
		[
			'failurePolicy: Ignore',
			'spec.failurePolicy',
			(f) => {
				specOf(f.policy).failurePolicy = 'Ignore'
			},
		],
		[
			'a failurePolicy the server left unset',
			'spec.failurePolicy',
			(f) => {
				// biome-ignore lint/performance/noDelete: absent, not undefined
				delete specOf(f.policy).failurePolicy
			},
		],
		[
			'a binding whose namespace selector names another namespace',
			'spec.matchResources.namespaceSelector',
			(f) => {
				specOf(f.binding).matchResources = {
					namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'elsewhere' } },
				}
			},
		],
		[
			'a binding whose namespace selector cannot be decided from the automatic label',
			'spec.matchResources.namespaceSelector',
			(f) => {
				specOf(f.binding).matchResources = {
					namespaceSelector: { matchLabels: { team: 'sandboxes' } },
				}
			},
		],
		[
			'a binding that excludes DELETE of ciliumnetworkpolicies',
			'spec.matchResources.excludeResourceRules',
			(f) => {
				specOf(f.binding).matchResources = {
					excludeResourceRules: [
						{
							apiGroups: ['cilium.io'],
							apiVersions: ['*'],
							operations: ['DELETE'],
							resources: ['ciliumnetworkpolicies'],
						},
					],
				}
			},
		],
		[
			'a binding whose resource rules leave UPDATE out',
			'spec.matchResources.resourceRules',
			(f) => {
				specOf(f.binding).matchResources = {
					resourceRules: [
						{
							apiGroups: ['cilium.io'],
							apiVersions: ['v2'],
							operations: ['CREATE', 'DELETE'],
							resources: ['ciliumnetworkpolicies'],
						},
					],
				}
			},
		],
		[
			'a binding scoped to objects carrying a label the host can leave off',
			'spec.matchResources.objectSelector',
			(f) => {
				specOf(f.binding).matchResources = { objectSelector: { matchLabels: { audited: 'yes' } } }
			},
		],
		[
			'a policy that does not match DELETE',
			'spec.matchConstraints.resourceRules',
			(f) => {
				specOf(f.policy).matchConstraints = {
					resourceRules: [
						{
							apiGroups: ['cilium.io'],
							apiVersions: ['v2'],
							operations: ['CREATE', 'UPDATE'],
							resources: ['ciliumnetworkpolicies'],
						},
					],
				}
			},
		],
		[
			'a policy that validates nothing',
			'spec.validations',
			(f) => {
				specOf(f.policy).validations = []
			},
		],
	]

	it.each(refusals)(
		'refuses %s, naming the field, with nothing written',
		async (_label, field, edit) => {
			const started = await startCluster()
			server = started.server
			edit(started.fence)
			const sandbox = await acquire()

			const failure = await sandbox
				.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
				.catch((err: unknown) => err)

			expect(failure).toBeInstanceOf(KubernetesAdmissionFenceInertError)
			expect((failure as KubernetesAdmissionFenceInertError).field).toBe(field)
			expect((failure as Error).message).toContain(field)
			expect(policyWrites(server)).toHaveLength(0)
			await sandbox.destroy()
		},
	)

	it('passes a correct fence, and one whose binding also audits', async () => {
		const started = await startCluster()
		server = started.server
		specOf(started.fence.binding).validationActions = ['Deny', 'Audit']
		const sandbox = await acquire()

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })).resolves.toBeUndefined()
		expect(policyWrites(server).some((w) => w.method === 'POST')).toBe(true)
		await sandbox.destroy()
	})

	it('also refuses the DELETE of an inert fence', async () => {
		const started = await startCluster()
		server = started.server
		specOf(started.fence.binding).validationActions = ['Audit']
		const sandbox = await acquire()

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [] })).rejects.toBeInstanceOf(
			KubernetesAdmissionFenceInertError,
		)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('is not memoized when it failed, and is memoized once it passed', async () => {
		const started = await startCluster()
		server = started.server
		specOf(started.fence.binding).validationActions = ['Audit']
		const sandbox = await acquire()

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })).rejects.toBeInstanceOf(
			KubernetesAdmissionFenceInertError,
		)
		specOf(started.fence.binding).validationActions = ['Deny']
		await sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['files.example.org'] })

		// Two failed-then-passed reads, then nothing more.
		expect(server.matching('GET', '/validatingadmissionpolicies/')).toHaveLength(2)
		await sandbox.destroy()
	})

	describe('hostIdentity', () => {
		const identity = 'system:serviceaccount:namzu-sandboxes:namzu-sandbox-host'

		it('passes when the policy names exactly that identity', async () => {
			const started = await startCluster()
			server = started.server
			const sandbox = await acquire(perSandboxConfig({ hostIdentity: identity }))

			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] }),
			).resolves.toBeUndefined()
			await sandbox.destroy()
		})

		it('refuses when the policy names another user, with nothing written', async () => {
			const started = await startCluster()
			server = started.server
			const sandbox = await acquire(
				perSandboxConfig({ hostIdentity: 'system:serviceaccount:other:host' }),
			)

			const failure = await sandbox
				.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
				.catch((err: unknown) => err)

			expect(failure).toBeInstanceOf(KubernetesAdmissionFenceInertError)
			expect((failure as KubernetesAdmissionFenceInertError).field).toBe('spec.matchConditions')
			expect(policyWrites(server)).toHaveLength(0)
			await sandbox.destroy()
		})

		it('does not check the identity when none is configured', async () => {
			const started = await startCluster()
			server = started.server
			specOf(started.fence.policy).matchConditions = [
				{ name: 'someone-else', expression: "request.userInfo.username == 'nobody'" },
			]
			const sandbox = await acquire()

			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] }),
			).resolves.toBeUndefined()
			await sandbox.destroy()
		})

		it('is refused during wiring when it is empty or space-padded', async () => {
			server = (await startCluster()).server
			for (const hostIdentity of ['', ' x']) {
				expect(() => buildKubernetesBackend(perSandboxConfig({ hostIdentity }))).toThrow(
					KubernetesPerSandboxEgressConfigError,
				)
			}
		})
	})
})

describe('permittedHostsParam (#617)', () => {
	const param = { name: 'namzu-per-sandbox-permitted-hosts', namespace: NAMESPACE }
	const pinned = (extra: Record<string, unknown> = {}) =>
		perSandboxConfig({
			permittedHostsParam: param,
			narrowing: { ports: [443] },
			...extra,
		})
	const setData = (
		started: { param: { current: Record<string, unknown> | undefined | 'forbidden' } },
		data: Record<string, unknown>,
	) => {
		started.param.current = { metadata: { name: param.name }, data }
	}
	const GOOD = {
		hosts: 'login.example.com\napi.example.com\nexample.com\n',
		patterns: '*.example.com\n',
		ports: '443\n',
	}

	it('writes a grant inside the set, on a port inside it', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const sandbox = await acquire(pinned())

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['login.example.com', '.example.com'] })

		expect([...started.policies.values()]).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses, locally and with nothing written, a host outside the set', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const sandbox = await acquire(pinned())

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['login.example.com', 'evil.example.net'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPermittedHostsError)
		expect((failure as KubernetesPermittedHostsError).hosts).toEqual(['evil.example.net'])
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('refuses a domain entry whose pattern is not listed, because it is a name plus a pattern', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, { ...GOOD, patterns: '' })
		const sandbox = await acquire(pinned())

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['.example.com'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPermittedHostsError)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('refuses a port outside the set', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const sandbox = await acquire(pinned({ narrowing: { ports: [443, 8443] } }))

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPermittedHostsError)
		expect((failure as KubernetesPermittedHostsError).ports).toEqual([8443])
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('refuses a grant that restricts no port at all, because every port is outside any list', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const noPorts = perSandboxConfig({ permittedHostsParam: param })
		const sandbox = await acquire(noPorts)

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPermittedHostsError)
		expect((failure as KubernetesPermittedHostsError).unrestrictedPortsFor).toEqual([
			'login.example.com',
		])
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('reads the ConfigMap on every grant, so an edit is honoured on the next call', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const sandbox = await acquire(pinned())

		await sandbox.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
		setData(started, { ...GOOD, hosts: 'api.example.com\n' })
		await expect(
			sandbox.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] }),
		).rejects.toBeInstanceOf(KubernetesPermittedHostsError)
		await sandbox.destroy()
	})

	const unusable: ReadonlyArray<
		readonly [string, (s: Awaited<ReturnType<typeof startCluster>>) => void]
	> = [
		[
			'a missing ConfigMap',
			(s) => {
				s.param.current = undefined
			},
		],
		[
			'an unreadable ConfigMap',
			(s) => {
				s.param.current = 'forbidden'
			},
		],
		[
			'a ConfigMap with no data',
			(s) => {
				s.param.current = { metadata: { name: 'x' } }
			},
		],
		['a missing key', (s) => setData(s, { hosts: GOOD.hosts, ports: GOOD.ports })],
		[
			'a host with trailing whitespace',
			(s) => setData(s, { ...GOOD, hosts: 'login.example.com \n' }),
		],
		[
			'a host that is not a hostname',
			(s) => setData(s, { ...GOOD, hosts: 'https://login.example.com\n' }),
		],
		['a domain entry in hosts', (s) => setData(s, { ...GOOD, hosts: '.example.com\n' })],
		['a pattern that is not *.domain', (s) => setData(s, { ...GOOD, patterns: 'example.com\n' })],
		['a pattern over a whole suffix', (s) => setData(s, { ...GOOD, patterns: '*.com\n' })],
		['a port that is not a number', (s) => setData(s, { ...GOOD, ports: 'https\n' })],
		['a port out of range', (s) => setData(s, { ...GOOD, ports: '70000\n' })],
	]

	it.each(unusable)('refuses every grant on %s, with nothing written', async (_label, arrange) => {
		const started = await startCluster()
		server = started.server
		arrange(started)
		const sandbox = await acquire(pinned())

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPermittedHostsParamError)
		expect(policyWrites(server)).toHaveLength(0)
		await sandbox.destroy()
	})

	it('does not block the revoke: an empty list needs no parameter', async () => {
		const started = await startCluster()
		server = started.server
		setData(started, GOOD)
		const sandbox = await acquire(pinned())
		await sandbox.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })

		started.param.current = undefined
		await sandbox.setNetworkPolicy?.({ allowedHosts: [] })

		expect(started.policies.size).toBe(0)
		expect(server.matching('GET', '/configmaps/')).toHaveLength(1)
		await sandbox.destroy()
	})

	describe('the companion fence', () => {
		type Edit = (fence: FenceObjects) => void
		const refusals: ReadonlyArray<readonly [string, string, Edit]> = [
			[
				'a binding with no parameter',
				'spec.paramRef',
				(f) => {
					// biome-ignore lint/performance/noDelete: absent, not undefined
					delete specOf(f.companionBinding).paramRef
				},
			],
			[
				'a binding that names another ConfigMap',
				'spec.paramRef.name',
				(f) => {
					specOf(f.companionBinding).paramRef = {
						...(specOf(f.companionBinding).paramRef as object),
						name: 'some-other-map',
					}
				},
			],
			[
				'a binding that allows when the parameter is missing',
				'spec.paramRef.parameterNotFoundAction',
				(f) => {
					specOf(f.companionBinding).paramRef = {
						...(specOf(f.companionBinding).paramRef as object),
						parameterNotFoundAction: 'Allow',
					}
				},
			],
			[
				'a binding that selects its parameter instead of naming it',
				'spec.paramRef.selector',
				(f) => {
					specOf(f.companionBinding).paramRef = {
						...(specOf(f.companionBinding).paramRef as object),
						selector: {},
					}
				},
			],
			[
				'an Audit-only companion binding',
				'spec.validationActions',
				(f) => {
					specOf(f.companionBinding).validationActions = ['Audit']
				},
			],
			[
				'a companion policy that fails open',
				'spec.failurePolicy',
				(f) => {
					specOf(f.companionPolicy).failurePolicy = 'Ignore'
				},
			],
			[
				'a companion policy of another parameter kind',
				'spec.paramKind',
				(f) => {
					specOf(f.companionPolicy).paramKind = { apiVersion: 'v1', kind: 'Secret' }
				},
			],
			[
				'a companion policy whose validation was loosened',
				'spec.validations',
				(f) => {
					specOf(f.companionPolicy).validations = [{ expression: 'true' }]
				},
			],
			[
				'a companion policy whose variables were edited',
				'spec.variables',
				(f) => {
					const variables = specOf(f.companionPolicy).variables as { expression: string }[]
					variables[1] = {
						...variables[1],
						expression: "params.data.hosts.split('\\n') + ['*']",
					} as never
				},
			],
		]

		it.each(refusals)('refuses %s, naming the field', async (_label, field, edit) => {
			const started = await startCluster()
			server = started.server
			setData(started, GOOD)
			edit(started.fence)
			const sandbox = await acquire(pinned())

			const failure = await sandbox
				.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
				.catch((err: unknown) => err)

			expect(failure).toBeInstanceOf(KubernetesAdmissionFenceInertError)
			expect((failure as KubernetesAdmissionFenceInertError).field).toBe(field)
			expect(policyWrites(server)).toHaveLength(0)
			await sandbox.destroy()
		})

		it('refuses a missing companion policy as a missing fence', async () => {
			const started = await startCluster({ fence: 'no-companion-policy' })
			server = started.server
			setData(started, GOOD)
			const sandbox = await acquire(pinned())

			const failure = await sandbox
				.setNetworkPolicy?.({ allowedHosts: ['login.example.com'] })
				.catch((err: unknown) => err)

			expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
			expect((failure as Error).message).toContain(`${ADMISSION_POLICY}-hosts`)
			expect(policyWrites(server)).toHaveLength(0)
			await sandbox.destroy()
		})
	})

	it('changes nothing when unset: no ConfigMap read, no companion read', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })

		expect(server.matching('GET', '/configmaps/')).toHaveLength(0)
		expect(
			server.requests.filter((r) => r.path.endsWith('-hosts') || r.path.endsWith('-hosts-binding')),
		).toHaveLength(0)
		await sandbox.destroy()
	})

	it('is refused during wiring when its name or namespace is empty', async () => {
		server = (await startCluster()).server
		for (const bad of [
			{ name: '', namespace: NAMESPACE },
			{ name: 'x', namespace: '' },
			{ name: ' x', namespace: NAMESPACE },
		]) {
			expect(() => buildKubernetesBackend(perSandboxConfig({ permittedHostsParam: bad }))).toThrow(
				KubernetesPerSandboxEgressConfigError,
			)
		}
	})
})

describe('the union is re-checked after every write (#617)', () => {
	/** A second CiliumNetworkPolicy selecting the same pods and allowing the whole world. */
	const WORLD_POLICY = {
		metadata: { name: 'someone-elses', namespace: NAMESPACE },
		spec: {
			endpointSelector: { matchLabels: TEMPLATE_LABEL },
			egress: [{ toEntities: ['world'] }],
		},
	}

	it('resolves when nothing else widens the pod', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })).resolves.toBeUndefined()

		expect(started.policies.size).toBe(1)
		expect(server.matching('GET', '/ciliumnetworkpolicies')).not.toHaveLength(0)
		await sandbox.destroy()
	})

	it('deletes its own object and throws KubernetesEgressPolicyUnionError when a policy applied since allows more', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		// Applied between the sandbox's create and its grant.
		started.others.push(WORLD_POLICY)

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		expect((failure as KubernetesEgressPolicyUnionError).refusal).toBe('policy-widens-egress')
		expect((failure as Error).message).toContain('someone-elses')
		expect(started.policies.size).toBe(0)
		expect(policyWrites(server).map((w) => w.method)).toContain('DELETE')
		await sandbox.destroy()
	})

	it('removes a policy that held an earlier verified list when the replacement fails', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		await sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		started.others.push(WORLD_POLICY)

		await expect(
			sandbox.setNetworkPolicy?.({ allowedHosts: ['files.example.org'] }),
		).rejects.toBeInstanceOf(KubernetesEgressPolicyUnionError)

		expect(started.policies.size).toBe(0)
		await sandbox.destroy()
	})

	it('counts the baseline plus the grant as within bounds, a .domain entry included', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire(perSandboxConfig({ narrowing: { ports: [443], dnsNames: true } }))

		await expect(
			sandbox.setNetworkPolicy?.({ allowedHosts: ['.example.com', REGISTRY] }),
		).resolves.toBeUndefined()
		await sandbox.destroy()
	})

	it('needs no re-check for a removal, which only narrows', async () => {
		const started = await startCluster()
		server = started.server
		const sandbox = await acquire()
		await sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		const listsBefore = server.matching('GET', '/ciliumnetworkpolicies').length
		started.others.push(WORLD_POLICY)

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [] })).resolves.toBeUndefined()

		expect(server.matching('GET', '/ciliumnetworkpolicies')).toHaveLength(listsBefore)
		await sandbox.destroy()
	})

	it("is skipped under egress.verify: 'named-object-only', as the create path's is", async () => {
		const started = await startCluster()
		server = started.server
		started.others.push(WORLD_POLICY)
		const sandbox = await acquire(perSandboxConfig({}, { verify: 'named-object-only' }))

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })).resolves.toBeUndefined()
		expect(started.policies.size).toBe(1)
		await sandbox.destroy()
	})

	it('says so when the removal fails too, because the policy may still be in force', async () => {
		const started = await startCluster({ deleteStatus: 403 })
		server = started.server
		const sandbox = await acquire()
		started.others.push(WORLD_POLICY)

		const failure = await sandbox
			.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPerSandboxPolicyNotRemovedError)
		expect((failure as KubernetesPerSandboxPolicyNotRemovedError).refusal).toBeInstanceOf(
			KubernetesEgressPolicyUnionError,
		)
		expect((failure as Error).message).toContain('may still be in force')
		await sandbox.destroy()
	})

	describe('under the no-network baseline this capability is for', () => {
		const NO_NETWORK = {
			metadata: { name: `${TEMPLATE}-egress`, namespace: NAMESPACE },
			spec: {
				podSelector: { matchLabels: TEMPLATE_LABEL },
				policyTypes: ['Egress'],
				egress: [],
			},
		}
		const narrowedConfig = () =>
			config({
				egress: {
					policy: { kind: 'no-network' },
					perSandbox: {
						engine: 'cilium' as const,
						admissionPolicyName: ADMISSION_POLICY,
						narrowing: { ports: [443], dnsNames: true },
					},
				},
			})

		it('counts baseline plus the narrowed grant as the boundary', async () => {
			const started = await startCluster({ baseline: NO_NETWORK })
			server = started.server
			const sandbox = await acquire(narrowedConfig())

			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY, '.example.com'] }),
			).resolves.toBeUndefined()
			await sandbox.destroy()
		})

		it('refuses a second policy that opens DNS to every name beside the narrowed grant', async () => {
			const started = await startCluster({ baseline: NO_NETWORK })
			server = started.server
			const sandbox = await acquire(narrowedConfig())
			started.others.push({
				metadata: { name: 'open-dns', namespace: NAMESPACE },
				spec: {
					endpointSelector: { matchLabels: TEMPLATE_LABEL },
					egress: [
						{
							toEndpoints: [
								{
									matchLabels: {
										'k8s:io.kubernetes.pod.namespace': 'kube-system',
										'k8s:k8s-app': 'kube-dns',
									},
								},
							],
							toPorts: [
								{
									ports: [{ port: '53', protocol: 'ANY' }],
									rules: { dns: [{ matchPattern: '*' }] },
								},
							],
						},
					],
				},
			})

			const failure = await sandbox
				.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
				.catch((err: unknown) => err)

			expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
			expect((failure as Error).message).toContain('open-dns')
			expect(started.policies.size).toBe(0)
			await sandbox.destroy()
		})
	})

	it('deletes the object when the read-back finds something else, too', async () => {
		const started = await startCluster({
			readBack: (written) => ({
				...written,
				spec: { ...(written.spec as object), egress: [{ toEntities: ['world'] }] },
			}),
		})
		server = started.server
		const sandbox = await acquire()

		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })).rejects.toThrow(
			/spec\.egress/,
		)

		expect(started.policies.size).toBe(0)
		await sandbox.destroy()
	})
})
