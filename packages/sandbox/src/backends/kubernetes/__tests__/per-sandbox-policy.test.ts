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

import { createKubernetesWorkspace as createWorkspaceFromPublicConfig } from '../../../index.js'
import {
	DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY,
	KubernetesPerSandboxEgressConfigError,
	KubernetesWorkspacePerSandboxEgressConfigError,
	buildCiliumEgressManifest,
	composeAdditionalPodLabels,
} from '../egress-policy.js'
import { type KubernetesBackendInternalConfig, buildKubernetesBackend } from '../index.js'
import {
	KubernetesAdmissionFenceMissingError,
	KubernetesAdmissionFenceUnreadableError,
	KubernetesNetworkPolicyHostError,
	KubernetesOwnerUidMissingError,
	PER_SANDBOX_POLICY_NAME_PREFIX,
	perSandboxPolicyName,
	perSandboxPolicyOwnerReference,
} from '../per-sandbox-policy.js'
import { createKubernetesWorkspace } from '../workspace.js'
import {
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
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
	readonly fence?: 'both' | 'no-policy' | 'no-binding' | 'unreadable'
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

async function startCluster(
	options: ClusterOptions = {},
): Promise<{ server: FakeApiServer; policies: PolicyStore }> {
	const policies: PolicyStore = new Map()
	const uidFor = options.uidFor ?? uidFromName
	const fence = options.fence ?? 'both'
	const api = await startFakeApiServer((req: RecordedRequest) => {
		// The admission fence, read before the first write.
		if (req.path.includes('/validatingadmissionpolicybindings/')) {
			return fence === 'no-binding' ? { status: 404, body: {} } : { status: 200, body: {} }
		}
		if (req.path.includes('/validatingadmissionpolicies/')) {
			if (fence === 'no-policy') return { status: 404, body: {} }
			if (fence === 'unreadable') return { status: 403, body: {} }
			return { status: 200, body: {} }
		}
		// The per-sandbox policies this backend writes.
		if (req.path.includes('/ciliumnetworkpolicies')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
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
				const existed = policies.delete(name)
				return existed ? { status: 200, body: {} } : { status: 404, body: {} }
			}
			const stored = policies.get(name)
			if (stored === undefined) return { status: 404, body: {} }
			return { status: 200, body: options.readBack?.(stored) ?? stored }
		}
		// The configured BASELINE — the named-object check and the union check.
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
	return { server: api, policies }
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

	it('refuses the same option on a workspace, which never carries the method at all', async () => {
		const started = await startCluster()
		server = started.server

		// A workspace handle is built without the setter, because nothing in
		// its create path composes a per-sandbox pod label or tracks an owner
		// uid for one. So a config this path cannot serve is REFUSED by name
		// rather than accepted with the method omitted: omitted, the caller
		// would believe it had narrowed a workspace's egress and nothing
		// anywhere would say otherwise — the "reads as applied, denies what it
		// names" failure every refusal in `egress-policy.ts` exists to
		// prevent, one level up.
		const failure = await createKubernetesWorkspace(config(), {
			workspaceId: 'refused-workspace',
			workingDirectory: '/workspace',
		}).then(
			() => undefined,
			(err: unknown) => err as Error,
		)

		expect(failure).toBeInstanceOf(KubernetesWorkspacePerSandboxEgressConfigError)
		expect(failure?.message).toContain('config.egress.perSandbox')
		expect(failure?.message).toContain('KubernetesWorkspace cannot carry the capability')
		// Before ANY request — not merely before a policy write: the refusal is
		// decidable from config alone, so it costs no round trip, and nothing
		// is created, patched or left standing behind it.
		expect(server.requests).toHaveLength(0)
	})

	it('refuses it through the PUBLIC verb too, with nothing sent', async () => {
		const started = await startCluster()
		server = started.server

		// The entry point a consumer actually calls, and the one the changeset
		// names: `createKubernetesWorkspace` from the package root. It maps the
		// public config to this backend's own and forwards `egress` verbatim,
		// so the case above is what a consumer gets — but "the wrapper forwards
		// it unchanged" is a claim about the wrapper, and this is the wrapper,
		// so it is pinned separately rather than inferred.
		//
		// No cluster is needed and none is contacted: the refusal is decidable
		// from config alone, before readiness is resolved and before the client
		// is built. `access` points at the fake server anyway, so a call that
		// DID reach the network would be recorded here rather than failing
		// against an address nothing answers — which would make "no requests"
		// true for the wrong reason.
		const failure = await createWorkspaceFromPublicConfig(
			{
				tier: 'microvm',
				service: 'kubernetes',
				namespace: NAMESPACE,
				access: { server: server.url, getToken: async () => 'sa-token' },
				sandboxTemplateName: TEMPLATE,
				egress: {
					policy: { kind: 'deny-all' },
					perSandbox: { engine: 'cilium', admissionPolicyName: ADMISSION_POLICY },
				},
			},
			{ workspaceId: 'refused-public-workspace', workingDirectory: '/workspace' },
		).then(
			() => undefined,
			(err: unknown) => err as Error,
		)

		expect(failure).toBeInstanceOf(KubernetesWorkspacePerSandboxEgressConfigError)
		expect(failure?.message).toContain('config.egress.perSandbox')
		expect(server.requests).toHaveLength(0)
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
				expandDomains: true,
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
				return fencePresent ? { status: 200, body: {} } : { status: 404, body: {} }
			}
			if (req.path.includes('/ciliumnetworkpolicies')) {
				if (req.method === 'POST') {
					const body = req.body as { metadata: { name: string } }
					policies.set(body.metadata.name, req.body as Record<string, unknown>)
					return { status: 201, body: req.body }
				}
				const name = req.path.slice(req.path.lastIndexOf('/') + 1)
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
		// The field path, asserted as its own half: this caller set
		// `egress.perSandbox.narrowing` and has no `ciliumNarrowing` in its
		// config at all, so the remedy the message offers only exists if the
		// message names that field. Pinned separately from the wording below,
		// so a change pairing this sentence with the config-level field fails
		// here rather than reading as a correct refusal. The same halves for
		// the config-level caller are pinned in `egress-policy.test.ts`, and
		// the translation's own derivation from `expandDomains` — the coupling
		// that makes the two callers agree — is pinned there too.
		expect((failure as Error).message).toContain('config.egress.perSandbox.narrowing')
		expect((failure as Error).message).not.toContain('config.egress.ciliumNarrowing')
		// The refusal is PATH-AWARE, and this is the expanded path: the entry
		// here really is a name plus a `*.domain` pattern, so the message may
		// say so and may offer the repair that follows from it. The
		// unexpanded wording — "this translation does not expand a leading-dot
		// entry … leaving tlsServerNames off does not repair the entry here" —
		// belongs to the config-level translation and is pinned in
		// `egress-policy.test.ts`; this writer must never carry it, because
		// leaving the option off here really does allow the domain and its
		// subdomains.
		expect((failure as Error).message).toContain(
			"this entry becomes a name plus a '*.domain' pattern",
		)
		expect((failure as Error).message).toContain(
			'list the exact hosts, or leave tlsServerNames off for a domain list',
		)
		expect((failure as Error).message).not.toContain('does not expand a leading-dot entry')
		// The closing grammar follows the same input, and on this path the
		// translation DOES apply it: the entry really does mean the domain and
		// its subdomains once expanded. Suppressed on the config-level path
		// only, where the body has just said the entry admits nothing.
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
			expandDomains: true,
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
