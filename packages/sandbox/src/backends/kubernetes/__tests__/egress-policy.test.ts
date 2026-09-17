/**
 * Egress translation and verify-not-trust, exercised without a cluster.
 *
 * Three concerns, kept apart the way the source file keeps them apart:
 *  - what {@link translateEgressPolicy} produces for each `EgressPolicy` kind
 *    and engine, including the refusal for a hostname allowlist with no
 *    FQDN-capable engine declared;
 *  - that the module never emits (or even spells, in a constant) a proxy
 *    environment variable;
 *  - that {@link verifyEgressPolicyApplied} actually compares the live
 *    object rather than trusting its name — the docker
 *    `assertNetworkCarriesThePolicy` precedent, transplanted.
 *
 * Full-flow verification against `buildKubernetesBackend(...).create()` and
 * a real fake HTTP API server lives in `./egress-verification.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import type { EgressPolicy } from '../../../index.js'
import {
	type EgressPolicyTarget,
	type EgressUnionDecision,
	type KubernetesEgressEngine,
	type KubernetesEgressPolicy,
	KubernetesEgressPolicyConfigError,
	KubernetesEgressPolicyMismatchError,
	KubernetesEgressPolicyNotAppliedError,
	KubernetesUnenforceableEgressPolicyError,
	assertEgressPolicyIsEnforceable,
	decideEgressUnion,
	defaultEgressPolicyName,
	egressAllowance,
	parseCidr,
	readCiliumEgressPolicies,
	readCoreEgressPolicies,
	translateEgressPolicy,
	verifyEgressPolicyApplied,
} from '../egress-policy.js'
import { KubernetesAlreadyGoneError, type KubernetesClient } from '../k8s-client.js'
import { SANDBOX_TEMPLATE_LABEL_KEY } from '../objects.js'

const TARGET: EgressPolicyTarget = {
	namespace: 'namzu-sandboxes',
	name: 'namzu-task-egress',
	sandboxTemplateName: 'namzu-task',
}

const EXPECTED_SELECTOR = { matchLabels: { [SANDBOX_TEMPLATE_LABEL_KEY]: 'namzu-task' } }

/**
 * The compatibility gate for this whole file: what `deny-all` and `allow-all`
 * emit, pinned by deep equality, BEFORE anything else is asserted.
 *
 * Verification of the named object is an exact match, so any change to either
 * manifest stops every already-applied policy from verifying and fails every
 * `create()` on every deployment until an operator re-applies it. "No
 * network" is therefore a NEW kind, and these two are frozen.
 */
describe('the two pre-existing translations are byte-identical to what shipped', () => {
	it('deny-all emits exactly this manifest', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		expect(translated.manifest).toStrictEqual({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: 'namzu-task-egress', namespace: 'namzu-sandboxes' },
			spec: {
				podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
				policyTypes: ['Egress'],
				egress: [
					{
						to: [
							{
								namespaceSelector: {
									matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
								},
							},
						],
						ports: [
							{ protocol: 'UDP', port: 53 },
							{ protocol: 'TCP', port: 53 },
						],
					},
				],
			},
		})
	})

	it('allow-all emits exactly this manifest', async () => {
		const translated = await translateEgressPolicy({ kind: 'allow-all' }, 'core', TARGET)
		expect(translated.manifest).toStrictEqual({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: 'namzu-task-egress', namespace: 'namzu-sandboxes' },
			spec: {
				podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
				policyTypes: ['Egress'],
				egress: [{}],
			},
		})
	})

	it('deny-all still allows the cluster resolver, which is why no-network exists', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const spec = (translated.manifest as { spec: { egress: unknown[] } }).spec
		// The claim the issue makes, asserted rather than described: a
		// `deny-all` sandbox keeps a channel out through the cluster's own
		// resolver, which forwards outside names upstream.
		expect(spec.egress).toHaveLength(1)
		const noNetwork = await translateEgressPolicy({ kind: 'no-network' }, 'core', TARGET)
		expect((noNetwork.manifest as { spec: { egress: unknown[] } }).spec.egress).toStrictEqual([])
	})
})

describe('no-network', () => {
	it('emits an egress-scoped policy with no rule at all', async () => {
		const translated = await translateEgressPolicy({ kind: 'no-network' }, 'core', TARGET)
		expect(translated.kind).toBe('NetworkPolicy')
		expect(translated.policyKind).toBe('no-network')
		expect(translated.manifest).toStrictEqual({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: 'namzu-task-egress', namespace: 'namzu-sandboxes' },
			spec: {
				podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
				// `policyTypes: ['Egress']` with an empty rule list is the API's
				// own spelling of "sends nothing" — dropping `policyTypes` would
				// make the object enforce nothing at all.
				policyTypes: ['Egress'],
				egress: [],
			},
		})
	})

	it('emits the same manifest under the cilium engine — core expresses it fully', async () => {
		const core = await translateEgressPolicy({ kind: 'no-network' }, 'core', TARGET)
		const cilium = await translateEgressPolicy({ kind: 'no-network' }, 'cilium', TARGET)
		expect(cilium.manifest).toStrictEqual(core.manifest)
	})
})

describe('public-internet', () => {
	it('emits DNS to the resolver plus everything except the ranges that are not the internet', async () => {
		const translated = await translateEgressPolicy({ kind: 'public-internet' }, 'core', TARGET)
		expect(translated.manifest).toStrictEqual({
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: 'namzu-task-egress', namespace: 'namzu-sandboxes' },
			spec: {
				podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
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
						ports: [
							{ protocol: 'UDP', port: 53 },
							{ protocol: 'TCP', port: 53 },
						],
					},
					{
						to: [
							{
								ipBlock: {
									cidr: '0.0.0.0/0',
									except: [
										'10.0.0.0/8',
										'172.16.0.0/12',
										'192.168.0.0/16',
										'100.64.0.0/10',
										'169.254.0.0/16',
										'127.0.0.0/8',
										'168.63.129.16/32',
									],
								},
							},
							{ ipBlock: { cidr: '::/0', except: ['fc00::/7', 'fe80::/10', '::1/128'] } },
						],
					},
				],
			},
		})
	})

	it('routes each deployment-supplied exception to the block of its own family', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'public-internet', exceptCidrs: ['203.0.113.0/24', '2001:db8::/32'] },
			'core',
			TARGET,
		)
		const rules = (translated.manifest as { spec: { egress: Record<string, unknown>[] } }).spec
			.egress
		const peers = rules[1]?.to as { ipBlock: { cidr: string; except: string[] } }[]
		expect(peers[0]?.ipBlock.except).toContain('203.0.113.0/24')
		expect(peers[0]?.ipBlock.except).not.toContain('2001:db8::/32')
		expect(peers[1]?.ipBlock.except).toContain('2001:db8::/32')
		// Added to the built-in list, never replacing it.
		expect(peers[0]?.ipBlock.except).toContain('169.254.0.0/16')
	})

	it('refuses an exceptCidrs entry that is not a CIDR, at construction', () => {
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'public-internet', exceptCidrs: ['203.0.113.0'] },
				'core',
			),
		).toThrow(KubernetesEgressPolicyConfigError)
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'public-internet', exceptCidrs: ['10.0.0.0/33'] },
				'core',
			),
		).toThrow(/exceptCidrs/)
	})

	it('accepts the two new kinds under every engine — neither needs an FQDN', () => {
		expect(() => assertEgressPolicyIsEnforceable({ kind: 'no-network' }, 'core')).not.toThrow()
		expect(() => assertEgressPolicyIsEnforceable({ kind: 'public-internet' }, 'core')).not.toThrow()
	})
})

describe('parseCidr', () => {
	it('reads IPv4, masking host bits rather than refusing them', () => {
		expect(parseCidr('10.0.0.1/8')).toEqual(parseCidr('10.0.0.0/8'))
		expect(parseCidr('10.0.0.0/33')).toBeUndefined()
		expect(parseCidr('10.0.0.256/8')).toBeUndefined()
		expect(parseCidr('10.0.0.0')).toBeUndefined()
	})

	it('reads IPv6 including the compressed and IPv4-mapped spellings', () => {
		expect(parseCidr('::1/128')).toEqual(parseCidr('0:0:0:0:0:0:0:1/128'))
		expect(parseCidr('::ffff:10.0.0.1/128')?.version).toBe(6)
		expect(parseCidr('fe80::/10')?.bits).toBe(10)
		expect(parseCidr('gg::/16')).toBeUndefined()
		expect(parseCidr('1:2:3/16')).toBeUndefined()
	})
})

describe('defaultEgressPolicyName', () => {
	it('derives a deterministic name from the template name', () => {
		expect(defaultEgressPolicyName('namzu-task')).toBe('namzu-task-egress')
	})
})

describe('deny-all and allow-all, under the core engine', () => {
	it('deny-all produces a NetworkPolicy allowing only cluster DNS', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)

		expect(translated.kind).toBe('NetworkPolicy')
		expect(translated.namespace).toBe(TARGET.namespace)
		expect(translated.name).toBe(TARGET.name)
		const manifest = translated.manifest as {
			apiVersion: string
			kind: string
			spec: { podSelector: unknown; policyTypes: string[]; egress: unknown[] }
		}
		expect(manifest.apiVersion).toBe('networking.k8s.io/v1')
		expect(manifest.kind).toBe('NetworkPolicy')
		expect(manifest.spec.podSelector).toEqual(EXPECTED_SELECTOR)
		expect(manifest.spec.policyTypes).toEqual(['Egress'])
		// Not an empty array: an empty `egress` under `policyTypes: ['Egress']`
		// denies DNS too, which would leave a pod unable to resolve anything at
		// all rather than merely unable to reach the world.
		expect(manifest.spec.egress).toHaveLength(1)
		expect(manifest.spec.egress[0]).toMatchObject({
			ports: expect.arrayContaining([
				{ protocol: 'UDP', port: 53 },
				{ protocol: 'TCP', port: 53 },
			]),
		})
	})

	it('allow-all produces a NetworkPolicy with an unrestricted egress rule', async () => {
		const translated = await translateEgressPolicy({ kind: 'allow-all' }, 'core', TARGET)
		const manifest = translated.manifest as { spec: { egress: unknown[] } }
		// `{}` with no `to`/`ports` matches every destination and port — the
		// DNS rule is a strict subset and is folded in rather than repeated.
		expect(manifest.spec.egress).toEqual([{}])
	})

	it('never produces the same egress shape for deny-all and allow-all', async () => {
		const deny = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const allow = await translateEgressPolicy({ kind: 'allow-all' }, 'core', TARGET)
		expect(deny.manifest).not.toEqual(allow.manifest)
	})
})

describe('static and resolver, under the core engine', () => {
	it('assertEgressPolicyIsEnforceable refuses static with no FQDN-capable engine', () => {
		expect(() =>
			assertEgressPolicyIsEnforceable({ kind: 'static', allowedHosts: ['a.example'] }, 'core'),
		).toThrow(KubernetesUnenforceableEgressPolicyError)
	})

	it('assertEgressPolicyIsEnforceable refuses resolver with no FQDN-capable engine', () => {
		const resolve = vi.fn(async () => ['a.example'])
		expect(() => assertEgressPolicyIsEnforceable({ kind: 'resolver', resolve }, 'core')).toThrow(
			KubernetesUnenforceableEgressPolicyError,
		)
		// The refusal is decided from the KIND alone — calling resolve() just
		// to prove a refusal would be wasted work and a possible side effect.
		expect(resolve).not.toHaveBeenCalled()
	})

	it('names the policy kind and the missing capability in the thrown message', async () => {
		await expect(
			translateEgressPolicy({ kind: 'static', allowedHosts: ['a.example'] }, 'core', TARGET),
		).rejects.toThrow(/'static'.*FQDN-capable policy engine/s)
		await expect(
			translateEgressPolicy(
				{ kind: 'resolver', resolve: async () => ['a.example'] },
				'core',
				TARGET,
			),
		).rejects.toThrow(/'resolver'.*FQDN-capable policy engine/s)
	})
})

describe('static and resolver, under the cilium engine', () => {
	it('static produces a CiliumNetworkPolicy with toFQDNs for every allowed host', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example', 'b.example'] },
			'cilium',
			TARGET,
		)

		expect(translated.kind).toBe('CiliumNetworkPolicy')
		const manifest = translated.manifest as {
			apiVersion: string
			kind: string
			spec: { endpointSelector: unknown; egress: Record<string, unknown>[] }
		}
		expect(manifest.apiVersion).toBe('cilium.io/v2')
		expect(manifest.kind).toBe('CiliumNetworkPolicy')
		expect(manifest.spec.endpointSelector).toEqual(EXPECTED_SELECTOR)
		const fqdnRule = manifest.spec.egress.find((rule) => 'toFQDNs' in rule) as
			| { toFQDNs: { matchName: string }[] }
			| undefined
		expect(fqdnRule?.toFQDNs).toEqual([{ matchName: 'a.example' }, { matchName: 'b.example' }])
	})

	it('resolver calls resolve() and builds toFQDNs from what it returned', async () => {
		const resolve = vi.fn(async () => ['tenant-a.example', 'tenant-b.example'])
		const translated = await translateEgressPolicy({ kind: 'resolver', resolve }, 'cilium', TARGET)
		expect(resolve).toHaveBeenCalledOnce()
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		const fqdnRule = manifest.spec.egress.find((rule) => 'toFQDNs' in rule) as
			| { toFQDNs: { matchName: string }[] }
			| undefined
		expect(fqdnRule?.toFQDNs).toEqual([
			{ matchName: 'tenant-a.example' },
			{ matchName: 'tenant-b.example' },
		])
	})

	it('carries a DNS-visibility rule alongside the toFQDNs rule (egress rules are unioned, so order is not significant)', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[0]).toHaveProperty('toEndpoints')
		expect(manifest.spec.egress[0]).toHaveProperty('toPorts')
		expect(manifest.spec.egress[1]).toHaveProperty('toFQDNs')
	})
})

describe('the switch over EgressPolicy is exhaustive', () => {
	it('refuses a synthetic policy kind at runtime instead of falling through', async () => {
		const bogus = { kind: 'future-kind' } as unknown as EgressPolicy
		await expect(translateEgressPolicy(bogus, 'core', TARGET)).rejects.toThrow(
			/unhandled egress policy kind/,
		)
	})

	it('refuses a synthetic policy kind at compile time — the real guard', () => {
		// @ts-expect-error 'future-kind' is not a member of EgressPolicy['kind'].
		// TypeScript refuses this call outright: a new EgressPolicy arm added
		// upstream without a matching case here would make this line — and the
		// `const exhaustive: never = policy` assignment inside
		// translateEgressPolicy's own default branch — both fail to compile,
		// which is what turns a missed case into a build failure rather than a
		// silent allow.
		const bogus: EgressPolicy = { kind: 'future-kind' }
		expect(bogus.kind).toBe('future-kind')
	})
})

describe('no proxy environment variable anywhere in this module', () => {
	const moduleSource = readFileSync(
		fileURLToPath(new URL('../egress-policy.ts', import.meta.url)),
		'utf8',
	)

	it('the source, outside comments and string/template literals, never spells a proxy env var', () => {
		// The module's doc comment and one error message DISCUSS
		// HTTP_PROXY/HTTPS_PROXY — naming what this module refuses to emit is
		// the whole point of that prose. Stripping comments and string/template
		// literals before scanning is what tells that apart from an actual
		// object key or identifier named after a proxy variable, which would be
		// the real defect this test exists to catch.
		const stripped = moduleSource
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '')
			.replace(/`(?:[^`\\]|\\.)*`/g, '``')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''")
			.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		expect(stripped).not.toMatch(/HTTP_PROXY|HTTPS_PROXY/)
	})

	it.each([
		['deny-all', { kind: 'deny-all' } as const],
		['allow-all', { kind: 'allow-all' } as const],
	])('%s produces no proxy variable in its manifest', async (_name, policy) => {
		const translated = await translateEgressPolicy(policy, 'core', TARGET)
		expect(JSON.stringify(translated.manifest)).not.toMatch(/HTTP_PROXY|HTTPS_PROXY/)
	})

	it('a cilium static translation produces no proxy variable in its manifest', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
		)
		expect(JSON.stringify(translated.manifest)).not.toMatch(/HTTP_PROXY|HTTPS_PROXY/)
	})
})

describe('verifyEgressPolicyApplied — verify, never trust', () => {
	function fakeClient(reply: (path: string) => unknown): KubernetesClient {
		return {
			request: (async (_method: string, path: string) => {
				const body = reply(path)
				if (body === undefined) throw new KubernetesAlreadyGoneError('GET', path, 404)
				return body
			}) as KubernetesClient['request'],
			namespace: () => TARGET.namespace,
		}
	}

	it('passes when the live NetworkPolicy matches the translation exactly', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const client = fakeClient(() => ({ spec: (translated.manifest as { spec: unknown }).spec }))
		await expect(verifyEgressPolicyApplied(client, translated)).resolves.toBeUndefined()
	})

	it('fails with a named error on a 404 — never creates the policy itself', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const client = fakeClient(() => undefined)
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			KubernetesEgressPolicyNotAppliedError,
		)
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			/never creates the egress policy itself/,
		)
	})

	it('fails with a named error when the podSelector does not match', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const expectedSpec = (translated.manifest as { spec: Record<string, unknown> }).spec
		const client = fakeClient(() => ({
			spec: { ...expectedSpec, podSelector: { matchLabels: { wrong: 'label' } } },
		}))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			KubernetesEgressPolicyMismatchError,
		)
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(/spec\.podSelector/)
	})

	it('fails when policyTypes omits Egress, even if the egress array is right', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const expectedSpec = (translated.manifest as { spec: Record<string, unknown> }).spec
		const client = fakeClient(() => ({ spec: { ...expectedSpec, policyTypes: ['Ingress'] } }))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(/policyTypes/)
	})

	it('fails when the egress rules differ from the translation', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const expectedSpec = (translated.manifest as { spec: Record<string, unknown> }).spec
		const client = fakeClient(() => ({ spec: { ...expectedSpec, egress: [{}] } }))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(/spec\.egress/)
	})

	it('checks endpointSelector, not podSelector, for a CiliumNetworkPolicy', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
		)
		const expectedSpec = (translated.manifest as { spec: Record<string, unknown> }).spec
		const client = fakeClient(() => ({ spec: expectedSpec }))
		await expect(verifyEgressPolicyApplied(client, translated)).resolves.toBeUndefined()
	})

	it('propagates a non-404 error from the API server rather than swallowing it', async () => {
		const translated = await translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET)
		const client: KubernetesClient = {
			request: vi.fn(async () => {
				throw new Error('boom')
			}),
			namespace: () => TARGET.namespace,
		}
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow('boom')
	})
})

describe('the engine type is exactly two values', () => {
	it.each(['core', 'cilium'] as const)('%s is a valid engine', (engine: KubernetesEgressEngine) => {
		expect(['core', 'cilium']).toContain(engine)
	})
})

/**
 * The union rule, in isolation: what one applied policy does to the verdict,
 * one shape per case.
 *
 * Kubernetes UNIONS every policy selecting a pod, so the question each case
 * asks is "does this second object let out something `config.egress` does
 * not" — never "does it look restrictive".
 */
const POD_LABELS = { 'sandbox.namzu.ai/template': 'namzu-task', app: 'namzu' }

/** The object an operator applies for `policy`, as the cluster would hold it. */
async function appliedTranslation(
	policy: KubernetesEgressPolicy,
	engine: KubernetesEgressEngine = 'core',
): Promise<Record<string, unknown>> {
	const translated = await translateEgressPolicy(policy, engine, TARGET)
	const manifest = translated.manifest as Record<string, unknown>
	return { metadata: { name: TARGET.name }, spec: manifest.spec }
}

async function decideCore(
	policy: KubernetesEgressPolicy,
	items: readonly unknown[],
	podLabels: Readonly<Record<string, string>> = POD_LABELS,
): Promise<EgressUnionDecision> {
	const translated = await translateEgressPolicy(policy, 'core', TARGET)
	const allowance = egressAllowance(translated)
	const target = {
		namespace: 'namzu-sandboxes',
		podLabels,
		engine: 'core' as const,
		subject: 'to create Sandbox namzu-task-1 in namespace namzu-sandboxes',
	}
	return decideEgressUnion(readCoreEgressPolicies(items, target, allowance), allowance)
}

async function decideCilium(
	policy: KubernetesEgressPolicy,
	coreItems: readonly unknown[],
	ciliumItems: readonly unknown[],
): Promise<EgressUnionDecision> {
	const translated = await translateEgressPolicy(policy, 'core', TARGET)
	const allowance = egressAllowance(translated)
	const target = {
		namespace: 'namzu-sandboxes',
		podLabels: POD_LABELS,
		engine: 'cilium' as const,
		subject: 'to create Sandbox namzu-task-1 in namespace namzu-sandboxes',
	}
	return decideEgressUnion(
		[
			...readCoreEgressPolicies(coreItems, target, allowance),
			...readCiliumEgressPolicies(ciliumItems, target, allowance),
		],
		allowance,
	)
}

/** The DNS rule `k8s/manifests/networkpolicy.yaml` ships — narrower than deny-all's. */
const BASELINE_DNS_RULE = {
	to: [
		{
			namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
			podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
		},
	],
	ports: [
		{ protocol: 'UDP', port: 53 },
		{ protocol: 'TCP', port: 53 },
	],
}

/** What the agent-sandbox controller writes when a template declares no `networkPolicy`. */
const CONTROLLER_DEFAULT_EGRESS_RULE = {
	to: [
		{
			ipBlock: {
				cidr: '0.0.0.0/0',
				except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'],
			},
		},
	],
}

function policyObject(
	name: string,
	spec: Record<string, unknown>,
	podSelector: unknown = { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
): Record<string, unknown> {
	return { metadata: { name }, spec: { podSelector, ...spec } }
}

describe('every applied translation is inside its own allowance', () => {
	// The one thing that would make every case below meaningless: a check
	// that refuses the very object it told the operator to apply.
	for (const policy of [
		{ kind: 'deny-all' },
		{ kind: 'allow-all' },
		{ kind: 'no-network' },
		{ kind: 'public-internet' },
		{ kind: 'public-internet', exceptCidrs: ['203.0.113.0/24'] },
	] as const) {
		it(`passes with only the ${policy.kind} object applied`, async () => {
			const decision = await decideCore(policy, [await appliedTranslation(policy)])
			expect(decision.refusal).toBeUndefined()
			expect(decision.examined.map((entry) => entry.verdict)).toEqual([
				policy.kind === 'allow-all' ? 'within' : 'within',
			])
		})
	}
})

describe('a second policy that widens egress', () => {
	it('refuses under deny-all and names the policy', async () => {
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			policyObject('open-everything', { policyTypes: ['Egress'], egress: [{}] }),
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		expect(decision.refusal?.summary).toContain('NetworkPolicy/open-everything')
		expect(decision.examined).toContainEqual(
			expect.objectContaining({ name: 'open-everything', verdict: 'widens-egress' }),
		)
	})

	it('accepts one that is narrower than the translation', async () => {
		// The repo's own baseline allows DNS to the RESOLVER'S PODS; deny-all
		// allows DNS to the whole kube-system namespace. The first is inside
		// the second, and a check that refused it would refuse the shipped
		// manifests.
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			policyObject('namzu-sandbox-baseline', {
				policyTypes: ['Ingress', 'Egress'],
				egress: [BASELINE_DNS_RULE],
			}),
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('refuses a public-internet deployment whose applied except list is one entry short', async () => {
		const decision = await decideCore({ kind: 'public-internet' }, [
			await appliedTranslation({ kind: 'public-internet' }),
			policyObject('controller-default', {
				policyTypes: ['Egress'],
				egress: [CONTROLLER_DEFAULT_EGRESS_RULE],
			}),
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		// The missing carve-outs are the finding: 100.64/10, 127/8 and the
		// platform endpoint are all reachable under that policy.
		expect(decision.refusal?.summary).toContain('controller-default')
	})

	it('accepts a policy inside the public-internet block', async () => {
		const decision = await decideCore({ kind: 'public-internet' }, [
			await appliedTranslation({ kind: 'public-internet' }),
			policyObject('vendor-api', {
				policyTypes: ['Egress'],
				egress: [
					{
						to: [{ ipBlock: { cidr: '203.0.113.0/24' } }],
						ports: [{ protocol: 'TCP', port: 443 }],
					},
				],
			}),
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('refuses a policy whose block straddles a carve-out', async () => {
		const decision = await decideCore({ kind: 'public-internet' }, [
			await appliedTranslation({ kind: 'public-internet' }),
			// 169.254.0.0/16 is excluded by the translation, so a policy
			// admitting the metadata address admits what the translation denies.
			policyObject('metadata-hole', {
				policyTypes: ['Egress'],
				egress: [{ to: [{ ipBlock: { cidr: '169.254.169.254/32' } }] }],
			}),
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})
})

describe('no-network', () => {
	it('refuses ANY egress rule on any selecting policy, DNS included', async () => {
		const decision = await decideCore({ kind: 'no-network' }, [
			await appliedTranslation({ kind: 'no-network' }),
			// Exactly what a SandboxTemplate's own `networkPolicy` block becomes
			// once the controller translates it.
			policyObject('template-managed', {
				policyTypes: ['Egress'],
				egress: [BASELINE_DNS_RULE],
			}),
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		expect(decision.refusal?.summary).toContain('permits no egress at all')
	})

	it('passes when nothing but the no-network object selects the pod', async () => {
		const decision = await decideCore({ kind: 'no-network' }, [
			await appliedTranslation({ kind: 'no-network' }),
		])
		expect(decision.refusal).toBeUndefined()
	})
})

describe('policies that do not decide anything', () => {
	it('ignores one whose selector does not match the pod', async () => {
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			policyObject(
				'other-workload',
				{ policyTypes: ['Egress'], egress: [{}] },
				{ matchLabels: { app: 'something-else' } },
			),
		])
		expect(decision.refusal).toBeUndefined()
		expect(decision.examined).toContainEqual(
			expect.objectContaining({ name: 'other-workload', verdict: 'does-not-select' }),
		)
	})

	it('ignores an egress block under a policyTypes that leaves Egress out', async () => {
		// The API server ignores it outright, so it neither bounds nor widens.
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			policyObject('ingress-only', { policyTypes: ['Ingress'], egress: [{}] }),
		])
		expect(decision.refusal).toBeUndefined()
		expect(decision.examined).toContainEqual(
			expect.objectContaining({ name: 'ingress-only', verdict: 'not-egress-scoped' }),
		)
	})

	it('reads an absent policyTypes as egress-scoped exactly when spec.egress is present', async () => {
		const withEgress = await decideCore({ kind: 'deny-all' }, [
			policyObject('defaulted', { egress: [BASELINE_DNS_RULE] }),
		])
		expect(withEgress.refusal).toBeUndefined()
		const withoutEgress = await decideCore({ kind: 'deny-all' }, [
			policyObject('ingress-shaped', { ingress: [{}] }),
		])
		expect(withoutEgress.refusal?.kind).toBe('no-enforcing-policy')
	})

	it('refuses when nothing puts the pod in egress default-deny', async () => {
		const decision = await decideCore({ kind: 'deny-all' }, [
			policyObject(
				'elsewhere',
				{ policyTypes: ['Egress'], egress: [] },
				{ matchLabels: { app: 'something-else' } },
			),
		])
		expect(decision.refusal?.kind).toBe('no-enforcing-policy')
		expect(decision.refusal?.summary).toContain("'deny-all'")
	})

	it('does not require a default-deny under allow-all, which asks for no boundary', async () => {
		const decision = await decideCore({ kind: 'allow-all' }, [])
		expect(decision.refusal).toBeUndefined()
	})

	it('refuses rather than guesses at a named port it cannot resolve', async () => {
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			policyObject('named-port', {
				policyTypes: ['Egress'],
				egress: [{ to: [{ ipBlock: { cidr: '203.0.113.0/24' } }], ports: [{ port: 'https' }] }],
			}),
		])
		expect(decision.refusal?.kind).toBe('not-evaluable')
	})

	it('refuses a policy object it cannot read at all', async () => {
		const decision = await decideCore({ kind: 'deny-all' }, [
			await appliedTranslation({ kind: 'deny-all' }),
			{ metadata: { name: 'broken' }, spec: { podSelector: {}, egress: 'not-a-list' } },
		])
		expect(decision.refusal?.kind).toBe('not-evaluable')
		expect(decision.refusal?.summary).toContain('broken')
	})
})

describe('the cilium engine, on the same union rule', () => {
	it('refuses a CiliumNetworkPolicy that admits an entity the translation does not', async () => {
		const decision = await decideCilium(
			{ kind: 'deny-all' },
			[await appliedTranslation({ kind: 'deny-all' })],
			[
				{
					metadata: { name: 'world-access' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
						egress: [{ toEntities: ['world'] }],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		expect(decision.refusal?.summary).toContain('CiliumNetworkPolicy/world-access')
	})

	it('still reads the rules of one that disables default-deny', async () => {
		// `enableDefaultDeny.egress: false` means it closes nothing — but what
		// it admits it still admits, so it cannot be skipped.
		const decision = await decideCilium(
			{ kind: 'deny-all' },
			[await appliedTranslation({ kind: 'deny-all' })],
			[
				{
					metadata: { name: 'allow-only' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
						enableDefaultDeny: { egress: false },
						egress: [{ toCIDR: ['0.0.0.0/0'] }],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})

	it('accepts a rule allowing exactly the cluster resolver', async () => {
		const decision = await decideCilium(
			{ kind: 'deny-all' },
			[await appliedTranslation({ kind: 'deny-all' })],
			[
				{
					metadata: { name: 'dns-only' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
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
										ports: [
											{ port: '53', protocol: 'UDP' },
											{ port: '53', protocol: 'TCP' },
										],
									},
								],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal).toBeUndefined()
	})

	it("refuses the same rule written with protocol 'ANY', which is more than TCP and UDP", async () => {
		// Not pedantry: `deny-all` allows UDP 53 and TCP 53 and nothing else,
		// and this check will not report a protocol it did not read as one of
		// them as being inside that. An operator writes the two protocols out,
		// or declares `verify: 'named-object-only'`.
		const decision = await decideCilium(
			{ kind: 'deny-all' },
			[await appliedTranslation({ kind: 'deny-all' })],
			[
				{
					metadata: { name: 'dns-any-protocol' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
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
								toPorts: [{ ports: [{ port: '53', protocol: 'ANY' }] }],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})

	it('ignores a node-scoped rule, which selects no pod', async () => {
		const decision = await decideCilium(
			{ kind: 'deny-all' },
			[await appliedTranslation({ kind: 'deny-all' })],
			[
				{
					metadata: { name: 'node-rule' },
					spec: { nodeSelector: {}, egress: [{ toEntities: ['all'] }] },
				},
			],
		)
		expect(decision.refusal).toBeUndefined()
	})
})
