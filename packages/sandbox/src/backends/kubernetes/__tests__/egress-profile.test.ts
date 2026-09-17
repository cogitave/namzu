/**
 * #498 — one warm pool serving several egress profiles.
 *
 * A profile is a pod LABEL. It travels onto the `SandboxClaim`'s
 * `additionalPodMetadata.labels`, onto a directly created Sandbox's pod
 * template, and into the translated policy's own selector and default name —
 * or onto none of them, which is what an unconfigured profile has to leave
 * byte-identical. Every one of those shapes, and every refusal, is provable
 * here against a fake API server.
 *
 * WHAT A KIND RUN PROVED AND THIS FILE CANNOT FABRICATE (kind-namzu, k8s
 * v1.37.0, agent-sandbox v1.0.2, controller args `--leader-elect=true
 * --extensions`, `agent-sandbox-config` ConfigMap absent so the controller's
 * built-in `allowed-label-domains` default applies):
 *  - a claim carrying `additionalPodMetadata.labels` ADOPTS a warm replica
 *    rather than cold-starting: six claims out of one two-replica pool,
 *    alternating the profile values `none` and `internet`, every adopt
 *    between 47 ms and 61 ms, and each bound pod one that already existed
 *    (the first two bound pods were 42 s older than the claims that took
 *    them);
 *  - the controller patches the label onto the RUNNING pod and into the
 *    Sandbox's own `spec.podTemplate.metadata.labels`;
 *  - a label key outside the allowlist is refused with condition
 *    `Ready=False`, `reason: InvalidMetadata`, and the message quoted
 *    verbatim in {@link CONTROLLER_INVALID_METADATA_MESSAGE} below — which
 *    is where this suite's copy comes from, rather than from any document.
 *
 * WHAT WAS MEASURED IN PLACE OF THE ISSUE'S "warm acquire p50 under 1 s for
 * both profiles": `k8s/scripts/acquire-p50.mjs` dials the guest agent, and
 * pod IPs are not routable from the machine this was run on, so the
 * controller-side adopt latency above (47-61 ms per claim, every bound pod a
 * pre-existing replica) is the substitute. The end-to-end number on a cluster
 * whose pod network the host can reach is unmeasured here.
 *
 * WHAT NOTHING HERE PROVES: the egress DIFFERENCE between two profiles.
 * kind has no Cilium data plane and kindnet does not enforce `NetworkPolicy`
 * at all, so "example.com fails from `none` and succeeds from `internet`"
 * needs a cluster that enforces, run with a positive control. See
 * `docs/sdk/kubernetes-sandbox.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	DEFAULT_EGRESS_PROFILE_LABEL_KEY,
	KubernetesEgressPolicyUnionError,
	KubernetesEgressProfileConfigError,
	KubernetesPodLabelNotObservedError,
	KubernetesPodLabelsRejectedError,
	composeAdditionalPodLabels,
	defaultEgressPolicyName,
	egressPolicySelectorLabels,
} from '../egress-policy.js'
import {
	KubernetesAcquireError,
	type KubernetesBackendInternalConfig,
	buildKubernetesBackend,
	buildSandboxBody,
	sandboxPodLabels,
} from '../index.js'
import { KubernetesWorkspaceMismatchError, createKubernetesWorkspace } from '../workspace.js'
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
const POOL_SANDBOX_NAME = 'egress-profile-sandbox-1'
const POD_UID = '5f2c9c9c-0e5d-4a2d-9e2a-19b1c0a8d201'
const TEMPLATE_LABEL = { 'sandbox.namzu.ai/template': TEMPLATE } as const
const PROFILE_KEY = 'sandbox.users.io/egress-profile'

/**
 * The controller's own refusal, copied out of a kind cluster running
 * agent-sandbox v1.0.2 (`kubectl get sandboxclaim ... -o jsonpath={.status}`)
 * rather than out of the issue text. The wording is load-bearing: it names
 * the ConfigMap key an operator has to edit, and the host surfaces it
 * verbatim instead of paraphrasing it.
 */
const CONTROLLER_INVALID_METADATA_MESSAGE =
	'invalid additionalPodMetadata: failed to validate label "sandbox.namzu.ai/egress-profile": label domain "sandbox.namzu.ai" is not in the allowlist (configure the allowed-label-domains key of the agent-sandbox-config ConfigMap in the controller namespace; default: sandbox.users.io)'

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

/** `deny-all`'s egress rule array — the shape both policies below carry. */
const DENY_ALL_EGRESS = [
	{
		to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
		ports: [
			{ protocol: 'UDP', port: 53 },
			{ protocol: 'TCP', port: 53 },
		],
	},
]

function denyAllSpec(selector: Record<string, string>): Record<string, unknown> {
	return {
		podSelector: { matchLabels: selector },
		policyTypes: ['Egress'],
		egress: DENY_ALL_EGRESS,
	}
}

interface ClusterOptions {
	/** Pod labels served by every `GET /pods/...`, in order; the last repeats. */
	readonly podLabelSeries?: readonly Readonly<Record<string, string>>[]
	/** Replaces the claim's Ready condition, e.g. to refuse the metadata. */
	readonly claimStatus?: Record<string, unknown>
	/** Policies the namespace enumerates. Defaults to the named one alone. */
	readonly policies?: readonly Record<string, unknown>[]
	readonly policyName?: string
	readonly policySelector?: Record<string, string>
	/** Called on each pod GET, before the reply, so ordering can be asserted. */
	readonly onPodRead?: () => void
}

function policyObject(name: string, selector: Record<string, string>): Record<string, unknown> {
	return { metadata: { name, namespace: NAMESPACE }, spec: denyAllSpec(selector) }
}

async function startCluster(options: ClusterOptions = {}): Promise<FakeApiServer> {
	const podLabels = options.podLabelSeries ?? [{ ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' }]
	const named = policyObject(
		options.policyName ?? `${TEMPLATE}-none-egress`,
		options.policySelector ?? { ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' },
	)
	let podReads = 0
	return await startFakeApiServer((req: RecordedRequest) => {
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 200, body: named }
		}
		if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
			return { status: 200, body: { items: options.policies ?? [named] } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
			return { status: 201, body: {} }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
			return {
				status: 200,
				body: {
					status: options.claimStatus ?? {
						conditions: [readyCondition()],
						sandbox: {
							name: POOL_SANDBOX_NAME,
							serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
						},
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return {
				status: 200,
				body: {
					spec: {
						podTemplate: {
							metadata: { labels: TEMPLATE_LABEL },
							spec: { containers: [{ name: 'agent', image: 'namzu/agent:test' }] },
						},
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			options.onPodRead?.()
			const labels = podLabels[Math.min(podReads, podLabels.length - 1)]
			podReads += 1
			return { status: 200, body: { metadata: { uid: POD_UID, labels } } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) return { status: 201, body: {} }
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			return {
				status: 200,
				body: {
					metadata: { name: 'namzu-task-direct' },
					status: {
						conditions: [readyCondition()],
						serviceFQDN: `namzu-task-direct.${NAMESPACE}.svc.cluster.local`,
					},
				},
			}
		}
		if (req.method === 'DELETE') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})
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
		// This suite is about the egress profile, not the agent port: the
		// fake server serves no ingress policy, so the check opts out exactly
		// as every other acquire fixture in this directory does.
		ingress: 'unverified' as const,
		...extra,
	}
}

function profiled(
	profile: string,
	extra: Partial<KubernetesBackendInternalConfig> = {},
): KubernetesBackendInternalConfig {
	return config({
		egress: { policy: { kind: 'deny-all' }, profile, profileLabelKey: PROFILE_KEY },
		...extra,
	})
}

describe('the profile label on the objects this backend creates', () => {
	it('puts it on the claim, and leaves the claim metadata and the rest of the spec alone', async () => {
		server = await startCluster()
		const backend = buildKubernetesBackend(
			profiled('none', { claimLabels: { 'sandbox.namzu.ai/host-instance': 'host-a' } }),
		)

		const sandbox = await backend.create({ workingDirectory: '/workspace' })

		const posted = server.matching('POST', '/sandboxclaims')
		expect(posted).toHaveLength(1)
		const body = posted[0]?.body as Record<string, unknown>
		// The POD label — the one the controller merges onto what it binds.
		expect(body.spec).toEqual({
			warmPoolRef: { name: POOL },
			additionalPodMetadata: { labels: { [PROFILE_KEY]: 'none' } },
			lifecycle: { shutdownTime: expect.any(String), shutdownPolicy: 'Delete' },
		})
		// #497's host identity is a DIFFERENT map on a DIFFERENT object and is
		// deliberately not merged into the one above: it is the host's own
		// bookkeeping on the claim, not something a policy selector reads.
		expect((body.metadata as Record<string, unknown>).labels).toEqual({
			'sandbox.namzu.ai/host-instance': 'host-a',
		})
		await sandbox.destroy()
	})

	it('puts the same map on a directly created Sandbox, from the same composer', async () => {
		server = await startCluster()
		const backend = buildKubernetesBackend(
			profiled('none', { warmPoolName: undefined, readyTimeoutMs: 2_000 }),
		)

		const sandbox = await backend.create({ workingDirectory: '/workspace' })

		const posted = server.matching('POST', '/sandboxes')
		expect(posted).toHaveLength(1)
		const spec = (posted[0]?.body as Record<string, unknown>).spec as Record<string, unknown>
		const podTemplate = spec.podTemplate as { metadata: { labels: Record<string, string> } }
		// A direct Sandbox has no controller to merge anything for it, so the
		// body stamps the labels itself — the SAME map the claim body carries,
		// which is what `composeAdditionalPodLabels` exists to guarantee.
		expect(podTemplate.metadata.labels).toEqual({ ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' })
		expect(podTemplate.metadata.labels).toMatchObject(
			composeAdditionalPodLabels({
				policy: { kind: 'deny-all' },
				profile: 'none',
				profileLabelKey: PROFILE_KEY,
			}),
		)
		await sandbox.destroy()
	})

	it('selects the profile label in the policy, under a per-profile default name', async () => {
		server = await startCluster()
		const backend = buildKubernetesBackend(profiled('none'))

		const sandbox = await backend.create({ workingDirectory: '/workspace' })

		// The default name carries the profile: one template under two
		// profiles is two policy objects, and one default name would have the
		// second verify against the first's manifest.
		expect(server.matching('GET', `/networkpolicies/${TEMPLATE}-none-egress`)).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses when the applied policy still selects the template label alone', async () => {
		// The selector is part of the exact-match verification, so a policy an
		// operator applied before profiles existed is drift, not a near miss.
		server = await startCluster({ policySelector: { ...TEMPLATE_LABEL } })
		const backend = buildKubernetesBackend(profiled('none'))

		const failure = await backend
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect((failure as Error).name).toBe('KubernetesEgressPolicyMismatchError')
		expect((failure as Error).message).toContain(PROFILE_KEY)
	})

	it('reports the profile label among the pod labels the union check examined', async () => {
		server = await startCluster({
			policies: [
				policyObject(`${TEMPLATE}-none-egress`, { ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' }),
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
		const backend = buildKubernetesBackend(profiled('none'))

		const failure = await backend
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyUnionError)
		const union = failure as KubernetesEgressPolicyUnionError
		// A policy selecting the template label alone still selects a profiled
		// pod — a selector is a subset match — so the union rule catches it,
		// and the refusal names the profile label the pod actually carried.
		expect(union.refusal).toBe('policy-widens-egress')
		expect(union.podLabels).toEqual({ ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' })
	})

	it('serves two profiles out of one warm pool, each with its own policy', async () => {
		const seen: string[] = []
		const claimProfiles = new Map<string, string>()
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				const name = req.path.slice(req.path.lastIndexOf('/') + 1)
				seen.push(name)
				const profile = name.includes('-none-') ? 'none' : 'internet'
				return {
					status: 200,
					body: policyObject(name, { ...TEMPLATE_LABEL, [PROFILE_KEY]: profile }),
				}
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return {
					status: 200,
					body: {
						items: [
							policyObject(`${TEMPLATE}-none-egress`, { ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' }),
							policyObject(`${TEMPLATE}-internet-egress`, {
								...TEMPLATE_LABEL,
								[PROFILE_KEY]: 'internet',
							}),
						],
					},
				}
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
				// One pool, two profiles: the claim NAME is a uuid either way,
				// so the profile is read off the body the host sent — which is
				// also the assertion that the label reached the wire at all.
				const body = req.body as {
					metadata: { name: string }
					spec: { additionalPodMetadata?: { labels?: Record<string, string> } }
				}
				claimProfiles.set(
					body.metadata.name,
					body.spec.additionalPodMetadata?.labels?.[PROFILE_KEY] ?? 'none',
				)
				return { status: 201, body: {} }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				const profile = claimProfiles.get(req.path.slice(req.path.lastIndexOf('/') + 1)) ?? 'none'
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: {
								name: `${POOL_SANDBOX_NAME}-${profile}`,
								serviceFQDN: `${POOL_SANDBOX_NAME}-${profile}.${NAMESPACE}.svc.cluster.local`,
							},
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				const profile = req.path.includes('internet') ? 'internet' : 'none'
				return {
					status: 200,
					body: {
						metadata: {
							uid: POD_UID,
							labels: { ...TEMPLATE_LABEL, [PROFILE_KEY]: profile },
						},
						status: { podIP: '127.0.0.1' },
					},
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		// Both backends name the SAME warm pool: that is the saving — one pool
		// of pods, two network modes, no second pool and no cold start. (kind
		// proved the adopt; this proves the two hosts' request shapes.)
		const none = buildKubernetesBackend(profiled('none'))
		const internet = buildKubernetesBackend(profiled('internet'))
		const first = await none.create({ workingDirectory: '/workspace' })
		const second = await internet.create({ workingDirectory: '/workspace' })

		const claims = server
			.matching('POST', '/sandboxclaims')
			.map((r) => (r.body as Record<string, unknown>).spec as Record<string, unknown>)
		expect(claims).toHaveLength(2)
		expect(claims[0]).toMatchObject({
			warmPoolRef: { name: POOL },
			additionalPodMetadata: { labels: { [PROFILE_KEY]: 'none' } },
		})
		expect(claims[1]).toMatchObject({
			warmPoolRef: { name: POOL },
			additionalPodMetadata: { labels: { [PROFILE_KEY]: 'internet' } },
		})
		expect(seen).toEqual([`${TEMPLATE}-none-egress`, `${TEMPLATE}-internet-egress`])
		await first.destroy()
		await second.destroy()
	})
})

describe('an unconfigured profile', () => {
	it('emits the same claim body, the same policy name and the same request log as before', async () => {
		server = await startCluster({
			policyName: `${TEMPLATE}-egress`,
			policySelector: { ...TEMPLATE_LABEL },
			policies: [policyObject(`${TEMPLATE}-egress`, { ...TEMPLATE_LABEL })],
			podLabelSeries: [{ ...TEMPLATE_LABEL }],
		})
		const backend = buildKubernetesBackend(config({ egress: { policy: { kind: 'deny-all' } } }))

		const sandbox = await backend.create({ workingDirectory: '/workspace' })

		const body = server.matching('POST', '/sandboxclaims')[0]?.body as Record<string, unknown>
		expect(body.spec).toEqual({
			warmPoolRef: { name: POOL },
			lifecycle: { shutdownTime: expect.any(String), shutdownPolicy: 'Delete' },
		})
		expect(body.spec).not.toHaveProperty('additionalPodMetadata')
		expect((body.metadata as Record<string, unknown>).labels).toBeUndefined()
		await sandbox.destroy()
		// The whole request log, in order: the named-object GET, the union
		// enumeration, the POST, one claim GET, one pod GET, the release. No
		// extra read is introduced by the profile machinery when no profile is
		// configured — the unprofiled path is the path it always was.
		const name = (body.metadata as { name: string }).name
		expect(server.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
			`GET /apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies/${TEMPLATE}-egress`,
			`POST /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims`,
			`GET /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims/${name}`,
			`GET /api/v1/namespaces/${NAMESPACE}/pods/${POOL_SANDBOX_NAME}`,
			`GET /apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies`,
			`DELETE /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxclaims/${name}`,
		])
	})

	it('keeps the unprofiled default policy name and selector', () => {
		expect(defaultEgressPolicyName(TEMPLATE)).toBe(`${TEMPLATE}-egress`)
		expect(defaultEgressPolicyName(TEMPLATE, 'none')).toBe(`${TEMPLATE}-none-egress`)
		expect(
			egressPolicySelectorLabels({
				namespace: NAMESPACE,
				name: 'x',
				sandboxTemplateName: TEMPLATE,
			}),
		).toEqual(TEMPLATE_LABEL)
		expect(composeAdditionalPodLabels(undefined)).toEqual({})
		expect(composeAdditionalPodLabels({ policy: { kind: 'deny-all' } })).toEqual({})
		expect(sandboxPodLabels({ podTemplate: { spec: {} } }, TEMPLATE)).toEqual(TEMPLATE_LABEL)
		expect(
			(
				buildSandboxBody({
					namespace: NAMESPACE,
					name: 'x',
					template: { podTemplate: { spec: {} } },
					sandboxTemplateName: TEMPLATE,
				}).spec as { podTemplate: { metadata: { labels: unknown } } }
			).podTemplate.metadata.labels,
		).toEqual(TEMPLATE_LABEL)
	})
})

describe('the label has to be observed on the bound pod', () => {
	it('does not dial the agent until the pod carries it, and then admits', async () => {
		let dialsWhileUnlabelled = 0
		let reads = 0
		server = await startCluster({
			podLabelSeries: [
				{ ...TEMPLATE_LABEL },
				{ ...TEMPLATE_LABEL },
				{ ...TEMPLATE_LABEL, [PROFILE_KEY]: 'none' },
			],
			onPodRead: () => {
				// Read at the moment the unlabelled pod is served: the privilege
				// probe is an `exec`, and an `exec` is a dial, so a dial before
				// the label has been seen is the failure this asserts against.
				if (reads < 2) dialsWhileUnlabelled += agent?.connections.length ?? 0
				reads += 1
			},
		})
		const backend = buildKubernetesBackend(profiled('none'))

		const sandbox = await backend.create({ workingDirectory: '/workspace' })

		expect(reads).toBe(3)
		expect(dialsWhileUnlabelled).toBe(0)
		// And the probe DID run once the label was there — otherwise this test
		// would pass for a backend that never probes at all.
		expect(agent?.requests.some((r) => r.op === 'execute')).toBe(true)
		await sandbox.destroy()
	})

	it('refuses, releases the claim and never dials when the label never arrives', async () => {
		server = await startCluster({ podLabelSeries: [{ ...TEMPLATE_LABEL }] })
		const backend = buildKubernetesBackend(profiled('none', { readyTimeoutMs: 300 }))

		const failure = await backend
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesPodLabelNotObservedError)
		const refusal = failure as KubernetesPodLabelNotObservedError
		expect(refusal.missingLabel).toEqual({ key: PROFILE_KEY, value: 'none' })
		expect(refusal.observedLabels).toEqual(TEMPLATE_LABEL)
		// An unlabelled pod is never admitted: it would bind under whatever
		// policy DOES select it while the host believes it is on this profile.
		expect(agent?.connections).toHaveLength(0)
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
	})
})

describe('a profile the controller refuses', () => {
	it('fails fast with the controller’s own reason, and leaves no claim behind', async () => {
		const defaultKeySelector = {
			...TEMPLATE_LABEL,
			[DEFAULT_EGRESS_PROFILE_LABEL_KEY]: 'none',
		}
		server = await startCluster({
			policySelector: defaultKeySelector,
			policies: [policyObject(`${TEMPLATE}-none-egress`, defaultKeySelector)],
			claimStatus: {
				conditions: [
					{
						type: 'Ready',
						status: 'False',
						reason: 'InvalidMetadata',
						message: CONTROLLER_INVALID_METADATA_MESSAGE,
						lastTransitionTime: '2026-09-17T03:38:31Z',
					},
				],
				sandbox: {},
			},
		})
		const backend = buildKubernetesBackend(
			// The DEFAULT key, which is exactly the one a stock controller
			// refuses — the operator prerequisite, stated as a test.
			config({ egress: { policy: { kind: 'deny-all' }, profile: 'none' }, readyTimeoutMs: 5_000 }),
		)

		const started = Date.now()
		const failure = await backend
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		// ONE taxonomy for a refused claim, profile or no profile:
		// `InvalidMetadata` is already a terminal claim reason, so this is the
		// acquire error a host catches for every other refusal too. A second
		// class thrown here would make a `catch` correct or incorrect
		// depending on whether a profile happened to be configured.
		expect(failure).toBeInstanceOf(KubernetesAcquireError)
		const acquire = failure as KubernetesAcquireError
		expect(acquire.reason).toBe('claim-rejected')
		expect(acquire.retryable).toBe(false)
		expect(acquire.controllerReason).toBe('InvalidMetadata')
		expect(acquire.controllerMessage).toBe(CONTROLLER_INVALID_METADATA_MESSAGE)
		// What the controller cannot know rides as the CAUSE: the map this
		// backend actually sent, and the config key that moves it.
		expect(acquire.cause).toBeInstanceOf(KubernetesPodLabelsRejectedError)
		const rejected = acquire.cause as KubernetesPodLabelsRejectedError
		expect(rejected.controllerReason).toBe('InvalidMetadata')
		expect(rejected.controllerMessage).toBe(CONTROLLER_INVALID_METADATA_MESSAGE)
		expect(rejected.profile).toEqual({ key: DEFAULT_EGRESS_PROFILE_LABEL_KEY, value: 'none' })
		// What was SENT, which is what the controller refused — and the gate
		// the cause is on, so a later capability's label gets the same
		// explanation rather than one naming a label it did not send.
		expect(rejected.requestedPodLabels).toEqual({ [DEFAULT_EGRESS_PROFILE_LABEL_KEY]: 'none' })
		// The operator reads the controller's own instructions off the thrown
		// error, not only off its cause.
		expect(acquire.message).toContain('allowed-label-domains')
		expect(acquire.message).toContain(DEFAULT_EGRESS_PROFILE_LABEL_KEY)
		expect(acquire.message).toContain('config.egress.profileLabelKey')
		// Fail FAST: one claim GET, not a readiness budget's worth of them.
		// Asserted on the request count rather than the clock.
		expect(server.matching('GET', '/sandboxclaims/')).toHaveLength(1)
		expect(Date.now() - started).toBeLessThan(5_000)
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
		expect(agent?.connections).toHaveLength(0)
	})

	it('leaves an unrecognised terminal reason to the readiness deadline', async () => {
		// A reason literal this backend does not know must never be able to
		// turn a transient condition into a refusal: the deadline is the
		// backstop, exactly as it was before the fail-fast existed.
		server = await startCluster({
			claimStatus: {
				conditions: [
					{
						type: 'Ready',
						status: 'False',
						reason: 'SomethingUpstreamRenamed',
						message: 'not ready yet',
						lastTransitionTime: '2026-09-17T03:38:31Z',
					},
				],
				sandbox: {},
			},
		})
		const backend = buildKubernetesBackend(profiled('none', { readyTimeoutMs: 200 }))

		const failure = await backend
			.create({ workingDirectory: '/workspace' })
			.catch((err: unknown) => err)

		// The deadline is what refuses it, not a reason literal: the acquire
		// error reports `not-ready` with the readiness timeout as its cause,
		// and no pod-label explanation is attached to a refusal the pod labels
		// did not cause.
		expect(failure).toBeInstanceOf(KubernetesAcquireError)
		const acquire = failure as KubernetesAcquireError
		expect(acquire.reason).toBe('not-ready')
		expect(acquire.controllerReason).toBeUndefined()
		expect((acquire.cause as Error | undefined)?.name).toBe('ReadinessPollTimeout')
		expect(server.matching('GET', '/sandboxclaims/').length).toBeGreaterThan(1)
	})
})

describe('a workspace under a profile', () => {
	const WORKSPACE_ID = 'acme-checkout-7'
	const WORKSPACE_NAME = 'namzu-ws-acme-checkout-7'
	const WORKSPACE_TEMPLATE = 'namzu-workspace'
	const WORKSPACE_LABEL = { 'sandbox.namzu.ai/template': WORKSPACE_TEMPLATE } as const

	it('stamps the label on its own Sandbox body, because no controller does it for it', async () => {
		const selector = { ...WORKSPACE_LABEL, [PROFILE_KEY]: 'none' }
		const policy = {
			metadata: { name: `${WORKSPACE_TEMPLATE}-none-egress`, namespace: NAMESPACE },
			spec: denyAllSpec(selector),
		}
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return {
					status: 200,
					body: {
						spec: {
							service: true,
							volumeClaimTemplates: [
								{
									metadata: { name: 'workspace' },
									spec: {
										accessModes: ['ReadWriteOnce'],
										volumeMode: 'Block',
										resources: { requests: { storage: '20Gi' } },
									},
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
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: policy }
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: [policy] } }
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) return { status: 201, body: {} }
			if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
				return { status: 200, body: {} }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				return {
					status: 200,
					body: {
						metadata: { name: WORKSPACE_NAME },
						spec: { operatingMode: 'Running' },
						status: {
							conditions: [readyCondition()],
							serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID, labels: selector } } }
			}
			return { status: 404, body: {} }
		})
		if (!agent) throw new Error('fixtures not started')

		const workspace = await createKubernetesWorkspace(
			{
				access: { server: server.url, getToken: async () => 'sa-token' },
				namespace: NAMESPACE,
				sandboxTemplateName: WORKSPACE_TEMPLATE,
				agentPort: agent.port,
				readyTimeoutMs: 2_000,
				readyPollIntervalMs: 5,
				ingress: 'unverified' as const,
				egress: { policy: { kind: 'deny-all' }, profile: 'none', profileLabelKey: PROFILE_KEY },
			},
			{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
		)

		const posted = server.matching('POST', '/sandboxes')
		expect(posted).toHaveLength(1)
		const spec = (posted[0]?.body as Record<string, unknown>).spec as Record<string, unknown>
		const podTemplate = spec.podTemplate as { metadata: { labels: Record<string, string> } }
		// The invariant: the profile label is on the claim, on a direct
		// Sandbox's pod template and in the policy selector — or on none of
		// them. A workspace is a direct Sandbox, so leaving it out here would
		// leave it selected by no profile policy at all.
		expect(podTemplate.metadata.labels).toEqual(selector)
		expect(
			server.matching('GET', `/networkpolicies/${WORKSPACE_TEMPLATE}-none-egress`),
		).toHaveLength(1)
		// `deleteDisk` rather than the default suspend: this fake cluster never
		// stops reporting a live pod, and the suspend path waits for one to go.
		// The workspace's own lifecycle is workspace-lifecycle.test.ts's
		// subject; this case is about the body it POSTed.
		await workspace.destroy({ deleteDisk: true })
	})

	/**
	 * A workspace whose deterministic name is already taken is ADOPTED — the
	 * normal path, since coming back to a workspace is what the name is for.
	 * Nothing patches a standing object's pod template, so an object built
	 * before the profile existed (or under another one) is a pod the
	 * per-profile policy does not select, and every check further up runs
	 * against the labels the POST *would* have stamped rather than against the
	 * object. Hence the refusal, and hence it happening before the resume.
	 */
	function startAdoptCluster(existingPodLabels: Record<string, string>): Promise<FakeApiServer> {
		const selector = { ...WORKSPACE_LABEL, [PROFILE_KEY]: 'none' }
		const policy = {
			metadata: { name: `${WORKSPACE_TEMPLATE}-none-egress`, namespace: NAMESPACE },
			spec: denyAllSpec(selector),
		}
		const volumeClaimTemplates = [
			{
				metadata: { name: 'workspace' },
				spec: {
					accessModes: ['ReadWriteOnce'],
					volumeMode: 'Block',
					resources: { requests: { storage: '20Gi' } },
				},
			},
		]
		const podTemplateSpec = {
			containers: [
				{
					name: 'main',
					image: 'namzu/agent:test',
					volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
				},
			],
		}
		return startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return {
					status: 200,
					body: {
						spec: {
							service: true,
							volumeClaimTemplates,
							podTemplate: { spec: podTemplateSpec },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: policy }
			}
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: [policy] } }
			}
			// The name is taken: this is the adopt path.
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
				return { status: 409, body: { message: 'sandboxes.agents.x-k8s.io already exists' } }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				return {
					status: 200,
					body: {
						metadata: { name: WORKSPACE_NAME },
						// Suspended, so a resume PATCH is what this call would
						// send next if it did not refuse: the refusal has to
						// leave the workspace ASLEEP rather than wake it up on
						// the way to rejecting it.
						spec: {
							operatingMode: 'Suspended',
							volumeClaimTemplates,
							podTemplate: { metadata: { labels: existingPodLabels }, spec: podTemplateSpec },
						},
						status: { conditions: [readyCondition('False')] },
					},
				}
			}
			return { status: 404, body: {} }
		})
	}

	function workspaceConfig(): Parameters<typeof createKubernetesWorkspace>[0] {
		if (!server || !agent) throw new Error('fixtures not started')
		return {
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: WORKSPACE_TEMPLATE,
			agentPort: agent.port,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
			egress: { policy: { kind: 'deny-all' }, profile: 'none', profileLabelKey: PROFILE_KEY },
		}
	}

	it('refuses to adopt one whose pod carries no profile label, without waking it', async () => {
		server = await startAdoptCluster({ ...WORKSPACE_LABEL })

		const failure = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		const mismatch = failure as KubernetesWorkspaceMismatchError
		expect(mismatch.field).toBe('egressProfile')
		expect(mismatch.expected).toBe(`${PROFILE_KEY}=none`)
		expect(mismatch.actual).toBeUndefined()
		// Selected by NO per-profile policy, and the message says which object
		// and which label rather than leaving an operator to diff two YAMLs.
		expect(mismatch.message).toContain(PROFILE_KEY)
		expect(mismatch.message).toContain(WORKSPACE_NAME)
		// Refused asleep: no resume patch, and nothing dialed.
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(agent?.connections).toHaveLength(0)
	})

	it('refuses to adopt one built under a different profile, naming both values', async () => {
		server = await startAdoptCluster({ ...WORKSPACE_LABEL, [PROFILE_KEY]: 'internet' })

		const failure = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		const mismatch = failure as KubernetesWorkspaceMismatchError
		expect(mismatch.field).toBe('egressProfile')
		expect(mismatch.expected).toBe(`${PROFILE_KEY}=none`)
		expect(mismatch.actual).toBe(`${PROFILE_KEY}=internet`)
		expect(mismatch.message).toContain('"internet"')
		expect(mismatch.message).toContain('"none"')
		expect(server.matching('PATCH', '/sandboxes/')).toHaveLength(0)
		expect(agent?.connections).toHaveLength(0)
	})

	it('adopts one whose pod carries the configured profile', async () => {
		// The positive control: the same adopt, one label different, and the
		// workspace comes back — so the two refusals above are not passing
		// because this fixture cannot adopt at all.
		server = await startAdoptCluster({ ...WORKSPACE_LABEL, [PROFILE_KEY]: 'none' })

		const failure = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		// This fixture serves no pod and no bound address, so the adopt gets
		// past every configuration check and fails on readiness instead —
		// which is the point: it is not refused for its labels.
		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceMismatchError)
		// It WAS woken: the resume patch this call would skip for a mismatched
		// object went out for a matching one.
		expect(server.matching('PATCH', '/sandboxes/').length).toBeGreaterThan(0)
	})
})

describe('a profile this backend will not emit', () => {
	it.each([
		['Internet', 'profile'],
		['a'.repeat(64), 'profile'],
		['-leading', 'profile'],
		['has space', 'profile'],
	])('refuses the value %s while the host is still being wired', (value, field) => {
		server = undefined
		const failure = ((): unknown => {
			try {
				buildKubernetesBackend({
					access: { server: 'http://127.0.0.1:1', getToken: async () => 't' },
					namespace: NAMESPACE,
					sandboxTemplateName: TEMPLATE,
					ingress: 'unverified' as const,
					egress: { policy: { kind: 'deny-all' }, profile: value },
				})
				return undefined
			} catch (err) {
				return err
			}
		})()
		expect(failure).toBeInstanceOf(KubernetesEgressProfileConfigError)
		expect((failure as KubernetesEgressProfileConfigError).field).toBe(field)
	})

	// The last key is legal and would be accepted by any API server: it is the
	// key this backend writes the template name under, and the profile is
	// applied last — so it would overwrite the template label on every pod
	// while the policy selector, built from the same resolution, agreed.
	it.each(['not a key', 'a/b/c', `${'x'.repeat(64)}`, 'sandbox.namzu.ai/template'])(
		'refuses the label key %s',
		(key) => {
			const failure = ((): unknown => {
				try {
					buildKubernetesBackend({
						access: { server: 'http://127.0.0.1:1', getToken: async () => 't' },
						namespace: NAMESPACE,
						sandboxTemplateName: TEMPLATE,
						ingress: 'unverified' as const,
						egress: { policy: { kind: 'deny-all' }, profile: 'none', profileLabelKey: key },
					})
					return undefined
				} catch (err) {
					return err
				}
			})()
			expect(failure).toBeInstanceOf(KubernetesEgressProfileConfigError)
			expect((failure as KubernetesEgressProfileConfigError).field).toBe('profileLabelKey')
		},
	)
})
