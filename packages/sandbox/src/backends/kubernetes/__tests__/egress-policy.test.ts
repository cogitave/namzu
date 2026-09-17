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
	type KubernetesCiliumEgressNarrowing,
	type KubernetesEgressEngine,
	KubernetesEgressNarrowingUnsupportedError,
	type KubernetesEgressPolicy,
	KubernetesEgressPolicyConfigError,
	KubernetesEgressPolicyMismatchError,
	KubernetesEgressPolicyNotAppliedError,
	KubernetesNetworkPolicyHostError,
	KubernetesUnenforceableEgressPolicyError,
	assertEgressPolicyIsEnforceable,
	buildCiliumEgressManifest,
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
 * The module's own (unexported) `CILIUM_DNS_VISIBILITY_RULE`, reproduced
 * here rather than imported — this file already inlines every other
 * expected manifest shape rather than importing the source's private
 * constants, e.g. `CLUSTER_DNS_EGRESS_RULE` above.
 */
const CILIUM_DNS_VISIBILITY_RULE_FOR_TESTS = {
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
}

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

/**
 * `#490` — narrowing a `static`/`resolver` allowlist by port, DNS name and
 * TLS server name. `ciliumNarrowing` unset (or every one of its fields
 * unset) is covered above and pinned byte-for-byte; this section covers
 * every combination of options being ON.
 */
describe('cilium narrowing — refused where it does not apply', () => {
	const narrowing: KubernetesCiliumEgressNarrowing = { ports: [443] }

	it('is a no-op — no refusal, no change in output — when every field is unset', async () => {
		const unnarrowed = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
		)
		const explicitlyEmpty = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{},
		)
		expect(explicitlyEmpty.manifest).toStrictEqual(unnarrowed.manifest)
		expect(() => assertEgressPolicyIsEnforceable({ kind: 'deny-all' }, 'core', {})).not.toThrow()
	})

	/**
	 * The plan's own TESTS note: today's tests (the `toHaveProperty`/
	 * `toMatchObject` assertions in "static and resolver, under the cilium
	 * engine" above, unmodified) only check the `toFQDNs` contents and that the
	 * DNS rule has the expected properties — they would not catch an
	 * accidental change to the rest of the default output. This pins the WHOLE
	 * manifest, the same way the deny-all/allow-all pins at the top of this
	 * file do, so the unnarrowed cilium static translation cannot silently
	 * drift either.
	 */
	it('the unnarrowed static translation is pinned byte-for-byte, the same way deny-all and allow-all are', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example', 'b.example'] },
			'cilium',
			TARGET,
		)
		expect(translated.manifest).toStrictEqual({
			apiVersion: 'cilium.io/v2',
			kind: 'CiliumNetworkPolicy',
			metadata: { name: 'namzu-task-egress', namespace: 'namzu-sandboxes' },
			spec: {
				endpointSelector: EXPECTED_SELECTOR,
				egress: [
					CILIUM_DNS_VISIBILITY_RULE_FOR_TESTS,
					{ toFQDNs: [{ matchName: 'a.example' }, { matchName: 'b.example' }] },
				],
			},
		})
	})

	it.each([
		['deny-all under cilium', { kind: 'deny-all' } as const, 'cilium' as const],
		['no-network under cilium', { kind: 'no-network' } as const, 'cilium' as const],
		['allow-all under cilium', { kind: 'allow-all' } as const, 'cilium' as const],
		['public-internet under cilium', { kind: 'public-internet' } as const, 'cilium' as const],
	])('refuses synchronously for %s', (_name, policy, engine) => {
		expect(() => assertEgressPolicyIsEnforceable(policy, engine, narrowing)).toThrow(
			KubernetesEgressNarrowingUnsupportedError,
		)
	})

	it('refuses from translateEgressPolicy too, before any await', async () => {
		await expect(
			translateEgressPolicy({ kind: 'deny-all' }, 'core', TARGET, narrowing),
		).rejects.toThrow(KubernetesEgressNarrowingUnsupportedError)
	})

	it('a static/resolver policy under engine core is still refused for lacking an FQDN-capable engine at all — narrowing does not change that error', () => {
		// `KubernetesUnenforceableEgressPolicyError` fires first here: the
		// engine cannot express a hostname allowlist AT ALL under `core`, which
		// is the more fundamental problem, so ciliumNarrowing being set on top
		// does not change which named error a caller sees.
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'static', allowedHosts: ['a.example'] },
				'core',
				narrowing,
			),
		).toThrow(KubernetesUnenforceableEgressPolicyError)
	})

	it('does not call resolve() when refusing a resolver policy under core engine', async () => {
		const resolve = vi.fn(async () => ['a.example'])
		await expect(
			translateEgressPolicy({ kind: 'resolver', resolve }, 'core', TARGET, narrowing),
		).rejects.toThrow(KubernetesUnenforceableEgressPolicyError)
		expect(resolve).not.toHaveBeenCalled()
	})

	it('accepts static and resolver under cilium — the only combination it applies to', async () => {
		await expect(
			translateEgressPolicy(
				{ kind: 'static', allowedHosts: ['a.example'] },
				'cilium',
				TARGET,
				narrowing,
			),
		).resolves.toBeDefined()
		await expect(
			translateEgressPolicy(
				{ kind: 'resolver', resolve: async () => ['a.example'] },
				'cilium',
				TARGET,
				narrowing,
			),
		).resolves.toBeDefined()
	})
})

describe('cilium narrowing — config validation', () => {
	it.each([
		['ports', { ports: [70000] }],
		['ports', { ports: [0] }],
		['ports', { ports: [1.5] }],
		['hostPorts', { hostPorts: { 'a.example': [-1] } }],
		['tlsPorts', { tlsServerNames: true, tlsPorts: [99999] }],
	])('refuses an unusable %s entry at construction', (_field, narrowing) => {
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'static', allowedHosts: ['a.example'] },
				'cilium',
				narrowing,
			),
		).toThrow(KubernetesEgressPolicyConfigError)
	})

	it.each([
		['ports', { ports: [] }],
		['hostPorts[host]', { hostPorts: { 'a.example': [] } }],
		['tlsPorts', { tlsServerNames: true, tlsPorts: [] }],
	])('refuses an explicitly empty %s array at construction', (_field, narrowing) => {
		// An empty array is neither "no restriction" (that is what omitting the
		// field means) nor a usable one: `narrowedHostFqdnRule` would emit
		// `toPorts: [{ ports: [] }]`, a shape the API server rejects on apply.
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'static', allowedHosts: ['a.example'] },
				'cilium',
				narrowing,
			),
		).toThrow(KubernetesEgressPolicyConfigError)
		expect(() =>
			assertEgressPolicyIsEnforceable(
				{ kind: 'static', allowedHosts: ['a.example'] },
				'cilium',
				narrowing,
			),
		).toThrow(/must not be an empty array/)
	})

	it('refuses an empty clusterDomain', () => {
		expect(() =>
			assertEgressPolicyIsEnforceable({ kind: 'static', allowedHosts: ['a.example'] }, 'cilium', {
				dnsNames: { clusterDomain: '  ' },
			}),
		).toThrow(KubernetesEgressPolicyConfigError)
	})

	it('refuses a blank search suffix', () => {
		expect(() =>
			assertEgressPolicyIsEnforceable({ kind: 'static', allowedHosts: ['a.example'] }, 'cilium', {
				dnsNames: { searchSuffixes: [''] },
			}),
		).toThrow(KubernetesEgressPolicyConfigError)
	})

	it('accepts valid ports at the boundaries (1 and 65535)', () => {
		expect(() =>
			assertEgressPolicyIsEnforceable({ kind: 'static', allowedHosts: ['a.example'] }, 'cilium', {
				ports: [1, 65535],
			}),
		).not.toThrow()
	})
})

describe('cilium narrowing — ports', () => {
	it('emits one toFQDNs rule per host, each with the default ports', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example', 'b.example'] },
			'cilium',
			TARGET,
			{ ports: [443] },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		// The DNS-visibility rule is untouched — only DNS-NAME narrowing
		// changes it — so it stays first and stays `matchPattern: '*'`.
		expect(manifest.spec.egress[0]).toStrictEqual(CILIUM_DNS_VISIBILITY_RULE_FOR_TESTS)
		expect(manifest.spec.egress.slice(1)).toStrictEqual([
			{
				toFQDNs: [{ matchName: 'a.example' }],
				toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
			},
			{
				toFQDNs: [{ matchName: 'b.example' }],
				toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
			},
		])
	})

	it('a per-host override replaces the default list for that host only', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example', 'b.example'] },
			'cilium',
			TARGET,
			{ ports: [443], hostPorts: { 'b.example': [22] } },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toMatchObject({
			toFQDNs: [{ matchName: 'a.example' }],
			toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
		})
		expect(manifest.spec.egress[2]).toMatchObject({
			toFQDNs: [{ matchName: 'b.example' }],
			toPorts: [{ ports: [{ port: '22', protocol: 'TCP' }] }],
		})
	})

	it('a host missing from hostPorts with no default set gets no port restriction', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{ hostPorts: { 'other.example': [22] } },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({ toFQDNs: [{ matchName: 'a.example' }] })
	})
})

describe('cilium narrowing — DNS names', () => {
	it('replaces matchPattern with an exact name per host and per search suffix', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ dnsNames: true },
		)
		const manifest = translated.manifest as {
			spec: { egress: { toPorts?: { rules?: { dns?: { matchName: string }[] } }[] }[] }
		}
		const dnsRule = manifest.spec.egress[0]
		expect(dnsRule?.toPorts?.[0]?.rules?.dns).toStrictEqual([
			{ matchName: 'github.com' },
			{ matchName: 'github.com.namzu-sandboxes.svc.cluster.local' },
			{ matchName: 'github.com.svc.cluster.local' },
			{ matchName: 'github.com.cluster.local' },
		])
		// The rest of the DNS-visibility rule (endpoints, port 53) is unchanged.
		expect(dnsRule).toMatchObject({ toEndpoints: CILIUM_DNS_VISIBILITY_RULE_FOR_TESTS.toEndpoints })
	})

	it('appends configured search suffixes after the three built-in ones', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ dnsNames: { searchSuffixes: ['corp.internal'] } },
		)
		const manifest = translated.manifest as {
			spec: { egress: { toPorts?: { rules?: { dns?: { matchName: string }[] } }[] }[] }
		}
		expect(manifest.spec.egress[0]?.toPorts?.[0]?.rules?.dns).toStrictEqual([
			{ matchName: 'github.com' },
			{ matchName: 'github.com.namzu-sandboxes.svc.cluster.local' },
			{ matchName: 'github.com.svc.cluster.local' },
			{ matchName: 'github.com.cluster.local' },
			{ matchName: 'github.com.corp.internal' },
		])
	})

	it('honours a configured namespace and clusterDomain override', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{ dnsNames: { namespace: 'other-ns', clusterDomain: 'corp.local' } },
		)
		const manifest = translated.manifest as {
			spec: { egress: { toPorts?: { rules?: { dns?: { matchName: string }[] } }[] }[] }
		}
		expect(manifest.spec.egress[0]?.toPorts?.[0]?.rules?.dns).toStrictEqual([
			{ matchName: 'a.example' },
			{ matchName: 'a.example.other-ns.svc.corp.local' },
			{ matchName: 'a.example.svc.corp.local' },
			{ matchName: 'a.example.corp.local' },
		])
	})

	it('narrows DNS names without touching toFQDNs ports when no port option is set', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{ dnsNames: true },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({ toFQDNs: [{ matchName: 'a.example' }] })
	})
})

describe('cilium narrowing — TLS server names', () => {
	it('the worked example from #490: a host with two ports, one TLS', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ hostPorts: { 'github.com': [443, 22] }, tlsServerNames: true },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({
			toFQDNs: [{ matchName: 'github.com' }],
			toPorts: [
				{ ports: [{ port: '443', protocol: 'TCP' }], serverNames: ['github.com'] },
				{ ports: [{ port: '22', protocol: 'TCP' }] },
			],
		})
	})

	it('limits a host to the default TLS ports when no port option is set', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{ tlsServerNames: true },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({
			toFQDNs: [{ matchName: 'a.example' }],
			toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }], serverNames: ['a.example'] }],
		})
	})

	it('honours a configured tlsPorts list instead of the 443 default', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['a.example'] },
			'cilium',
			TARGET,
			{ hostPorts: { 'a.example': [8443, 80] }, tlsServerNames: true, tlsPorts: [8443] },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({
			toFQDNs: [{ matchName: 'a.example' }],
			toPorts: [
				{ ports: [{ port: '8443', protocol: 'TCP' }], serverNames: ['a.example'] },
				{ ports: [{ port: '80', protocol: 'TCP' }] },
			],
		})
	})

	it('every option together: ports, DNS names and TLS server names', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ hostPorts: { 'github.com': [443, 22] }, tlsServerNames: true, dnsNames: true },
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress).toHaveLength(2)
		expect(
			(manifest.spec.egress[0] as { toPorts: { rules: { dns: unknown[] } }[] }).toPorts[0]?.rules
				.dns,
		).toHaveLength(4)
		expect(manifest.spec.egress[1]).toStrictEqual({
			toFQDNs: [{ matchName: 'github.com' }],
			toPorts: [
				{ ports: [{ port: '443', protocol: 'TCP' }], serverNames: ['github.com'] },
				{ ports: [{ port: '22', protocol: 'TCP' }] },
			],
		})
	})

	it('resolver: narrowing applies to what resolve() returned, not to allowedHosts', async () => {
		const resolve = vi.fn(async () => ['tenant.example'])
		const translated = await translateEgressPolicy(
			{ kind: 'resolver', resolve },
			'cilium',
			TARGET,
			{
				ports: [443],
			},
		)
		const manifest = translated.manifest as { spec: { egress: Record<string, unknown>[] } }
		expect(manifest.spec.egress[1]).toStrictEqual({
			toFQDNs: [{ matchName: 'tenant.example' }],
			toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
		})
	})

	it('refuses a .domain entry while tlsServerNames is on, at the translation', async () => {
		// `serverNames: ['.example.com']` is not a name any handshake
		// presents, and `['example.com']` would deny every subdomain the
		// `toFQDNs` half of the same rule admits. Either way the object is
		// admitted by the shipped fence and reads back deep-equal to what was
		// sent, so a translation that emitted it would report success and
		// deny the domain it was asked to allow — refused HERE, where every
		// caller passes: the config-level translation below, the per-sandbox
		// writer (which refuses earlier still, with its own field path), and
		// a direct call to `buildCiliumEgressManifest`.
		const failure = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['.example.com', 'registry.npmjs.org'] },
			'cilium',
			TARGET,
			{ tlsServerNames: true },
		).then(
			() => undefined,
			(err: unknown) => err as Error,
		)

		expect(failure).toBeInstanceOf(KubernetesNetworkPolicyHostError)
		// The field path, asserted as its own half: this caller set
		// `config.egress.ciliumNarrowing` and nothing else, so the refusal has
		// to send it there — and never to the per-sandbox field, whose remedy
		// (`perSandbox.narrowing`) does not exist in this host's config at all.
		// Pinned separately from the wording below so that a change pairing one
		// caller's sentence with the other caller's field fails here rather
		// than reading as a correct refusal, which is exactly how the expanding
		// caller came to be sent to the config-level field.
		expect(failure?.message).toContain('config.egress.ciliumNarrowing')
		expect(failure?.message).not.toContain('config.egress.perSandbox.narrowing')
		// The message says what is true of THIS caller, and this caller is the
		// unexpanded one: the entry below is emitted as a literal `matchName`,
		// not expanded into a name plus a pattern, so the refusal cannot claim
		// it "becomes a name plus a '*.domain' pattern" — and the remedy that
		// sentence offers ("leave tlsServerNames off for a domain list") is not
		// a repair here, because that emission admits nothing either. Both
		// halves are asserted: the caller that IS expanded is pinned in
		// `per-sandbox-policy.test.ts`.
		expect(failure?.message).toContain('this translation does not expand a leading-dot entry')
		expect(failure?.message).toContain(`the literal matchName ${JSON.stringify('.example.com')}`)
		expect(failure?.message).toContain('a second, independent denial')
		expect(failure?.message).not.toContain("becomes a name plus a '*.domain' pattern")
		// And the closing grammar is suppressed here, because this translation
		// does not implement it: the body has just said the entry admits
		// nothing as written, and a tail re-stating that `.example.com` means
		// the domain and its subdomains would describe a behaviour that is the
		// reason this entry is refused rather than the behaviour it gets.
		expect(failure?.message).not.toContain('Entries are hostnames')
		expect(failure?.message).toContain('Nothing was written')

		// The refusal belongs to the COMBINATION, not to either half. The
		// leading dot alone is untouched here — the config-level translation
		// has never expanded anything and its emitted bytes are pinned, so the
		// refusal is about the SNI value the option would attach to it, not
		// about the entry. What that entry emits on its own is `matchName:
		// '.example.com'`, a literal no DNS answer carries: it matches nothing
		// either way, which is a pre-existing defect of this translation
		// (deferred, with its own change) and the second denial `serverNames`
		// would add on top of it. The option alone is untouched, with
		// `serverNames` holding the exact host.
		const domains = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['.example.com'] },
			'cilium',
			TARGET,
			{ ports: [443] },
		)
		expect(
			(domains.manifest as { spec: { egress: Record<string, unknown>[] } }).spec.egress[1],
		).toStrictEqual({
			toFQDNs: [{ matchName: '.example.com' }],
			toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
		})

		const exact = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['registry.npmjs.org'] },
			'cilium',
			TARGET,
			{ tlsServerNames: true },
		)
		expect(
			(exact.manifest as { spec: { egress: Record<string, unknown>[] } }).spec.egress[1],
		).toStrictEqual({
			toFQDNs: [{ matchName: 'registry.npmjs.org' }],
			toPorts: [
				{
					ports: [{ port: '443', protocol: 'TCP' }],
					serverNames: ['registry.npmjs.org'],
				},
			],
		})
	})

	it('sends a DIRECT expanding call to the per-sandbox field it would have set', () => {
		// `buildCiliumEgressManifest` is the shared translation, and a caller
		// reaching it directly is the shape the builder's own comment claims to
		// cover — with no earlier check standing between the option and the
		// message. `expandDomains` is the one option that says which translation
		// is being built, so it has to decide the field path as well as the
		// sentence: decided independently, this caller was told to repair
		// `config.egress.ciliumNarrowing` with the remedy that belongs to
		// `config.egress.perSandbox.narrowing`, a field it never set. Both
		// halves are asserted, so pairing either sentence with the other
		// caller's field fails here.
		const refusal = ((): Error | undefined => {
			try {
				buildCiliumEgressManifest({
					namespace: TARGET.namespace,
					name: TARGET.name,
					selectorLabels: EXPECTED_SELECTOR.matchLabels,
					allowedHosts: ['.example.com'],
					policyKind: 'static',
					narrowing: { tlsServerNames: true },
					expandDomains: true,
				})
				return undefined
			} catch (err) {
				return err as Error
			}
		})()

		expect(refusal).toBeInstanceOf(KubernetesNetworkPolicyHostError)
		expect(refusal?.message).toContain('config.egress.perSandbox.narrowing')
		expect(refusal?.message).not.toContain('config.egress.ciliumNarrowing')
		expect(refusal?.message).toContain("this entry becomes a name plus a '*.domain' pattern")
		expect(refusal?.message).not.toContain('does not expand a leading-dot entry')
		// Expanding is the translation that DOES apply the hostname grammar,
		// so this half keeps it — the suppression belongs to the other one.
		expect(refusal?.message).toContain('Entries are hostnames')

		// And the same options with `expandDomains` off are the config-level
		// caller's message: the option, not the function, decides.
		const unexpanded = ((): Error | undefined => {
			try {
				buildCiliumEgressManifest({
					namespace: TARGET.namespace,
					name: TARGET.name,
					selectorLabels: EXPECTED_SELECTOR.matchLabels,
					allowedHosts: ['.example.com'],
					policyKind: 'static',
					narrowing: { tlsServerNames: true },
				})
				return undefined
			} catch (err) {
				return err as Error
			}
		})()

		expect(unexpanded?.message).toContain('config.egress.ciliumNarrowing')
		expect(unexpanded?.message).not.toContain('config.egress.perSandbox.narrowing')
		expect(unexpanded?.message).not.toContain('Entries are hostnames')
	})
})

describe('cilium narrowing — verifyEgressPolicyApplied catches every new field', () => {
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

	it('passes when the applied object matches the narrowed translation exactly', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ hostPorts: { 'github.com': [443, 22] }, tlsServerNames: true, dnsNames: true },
		)
		const client = fakeClient(() => ({ spec: (translated.manifest as { spec: unknown }).spec }))
		await expect(verifyEgressPolicyApplied(client, translated)).resolves.toBeUndefined()
	})

	it('fails when the applied object is missing a configured toPorts entry', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ ports: [443] },
		)
		const expectedSpec = (translated.manifest as { spec: { egress: Record<string, unknown>[] } })
			.spec
		const droppedPorts = {
			...expectedSpec,
			egress: expectedSpec.egress.map((rule) =>
				'toFQDNs' in rule ? { toFQDNs: rule.toFQDNs } : rule,
			),
		}
		const client = fakeClient(() => ({ spec: droppedPorts }))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			KubernetesEgressPolicyMismatchError,
		)
	})

	it('fails when the applied object is missing the narrowed DNS names', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ dnsNames: true },
		)
		const expectedSpec = (translated.manifest as { spec: unknown }).spec
		const client = fakeClient(() => ({
			spec: {
				...(expectedSpec as Record<string, unknown>),
				egress: [CILIUM_DNS_VISIBILITY_RULE_FOR_TESTS],
			},
		}))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			KubernetesEgressPolicyMismatchError,
		)
	})

	it('fails when the applied object is missing a configured serverNames entry', async () => {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			{ tlsServerNames: true },
		)
		const expectedSpec = (translated.manifest as { spec: { egress: Record<string, unknown>[] } })
			.spec
		const droppedServerNames = {
			...expectedSpec,
			egress: expectedSpec.egress.map((rule) => {
				if (!('toFQDNs' in rule)) return rule
				const toPorts = rule.toPorts as Record<string, unknown>[]
				return { ...rule, toPorts: toPorts.map(({ serverNames: _serverNames, ...rest }) => rest) }
			}),
		}
		const client = fakeClient(() => ({ spec: droppedServerNames }))
		await expect(verifyEgressPolicyApplied(client, translated)).rejects.toThrow(
			KubernetesEgressPolicyMismatchError,
		)
	})
})

describe('cilium narrowing — the union check reads per-host ports on toFQDNs', () => {
	const narrowedTargetPodLabels = { 'sandbox.namzu.ai/template': 'namzu-task', app: 'namzu' }

	async function decideCiliumNarrowed(
		policy: KubernetesEgressPolicy,
		narrowing: KubernetesCiliumEgressNarrowing,
		ciliumItems: readonly unknown[],
	): Promise<EgressUnionDecision> {
		const translated = await translateEgressPolicy(policy, 'cilium', TARGET, narrowing)
		const allowance = egressAllowance(translated)
		const target = {
			namespace: 'namzu-sandboxes',
			podLabels: narrowedTargetPodLabels,
			engine: 'cilium' as const,
			subject: 'to create Sandbox namzu-task-1 in namespace namzu-sandboxes',
		}
		return decideEgressUnion(readCiliumEgressPolicies(ciliumItems, target, allowance), allowance)
	}

	it('accepts a second policy naming the same host on an allowed port', async () => {
		const decision = await decideCiliumNarrowed(
			{ kind: 'static', allowedHosts: ['github.com'] },
			{ ports: [443] },
			[
				{
					metadata: { name: 'extra' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
						egress: [
							{
								toFQDNs: [{ matchName: 'github.com' }],
								toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal).toBeUndefined()
	})

	it('refuses a second policy naming the same host on a port the narrowed translation does not allow', async () => {
		const decision = await decideCiliumNarrowed(
			{ kind: 'static', allowedHosts: ['github.com'] },
			{ ports: [443] },
			[
				{
					metadata: { name: 'ssh-hole' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
						egress: [
							{
								toFQDNs: [{ matchName: 'github.com' }],
								toPorts: [{ ports: [{ port: '22', protocol: 'TCP' }] }],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		expect(decision.refusal?.summary).toContain('CiliumNetworkPolicy/ssh-hole')
	})

	it('refuses a second policy naming the same host with no port restriction at all', async () => {
		const decision = await decideCiliumNarrowed(
			{ kind: 'static', allowedHosts: ['github.com'] },
			{ ports: [443] },
			[
				{
					metadata: { name: 'wide-open' },
					spec: {
						endpointSelector: { matchLabels: { 'k8s:sandbox.namzu.ai/template': 'namzu-task' } },
						egress: [{ toFQDNs: [{ matchName: 'github.com' }] }],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})
})

/**
 * `#490`'s manifest decision, closed by refusal rather than by trusting an
 * operator noticed a comment: `packages/sandbox/k8s/manifests/*.yaml` ship a
 * plain, L4-only kube-dns rule with no `rules.dns` restriction. Reachability
 * alone (`destinationIsAllowed`) cannot tell that rule apart from a narrowed
 * one — both reach the same peer on the same port — so this is the check that
 * actually distinguishes them: `EgressAllowance.dnsNarrowedTo`, read by
 * `reachesResolverAtDnsPort` inside `coreEgressRuleVerdict` and
 * `ciliumEgressRuleVerdict` before either falls back to the ordinary
 * peer/port comparison.
 */
describe('cilium narrowing — a co-existing kube-dns rule can widen a narrowed DNS allowance', () => {
	const dnsWideningTargetPodLabels = { 'sandbox.namzu.ai/template': 'namzu-task', app: 'namzu' }

	async function decideAgainstNarrowedDns(
		narrowing: KubernetesCiliumEgressNarrowing,
		coreItems: readonly unknown[],
		ciliumItems: readonly unknown[] = [],
	): Promise<EgressUnionDecision> {
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['github.com'] },
			'cilium',
			TARGET,
			narrowing,
		)
		const allowance = egressAllowance(translated)
		const target = {
			namespace: 'namzu-sandboxes',
			podLabels: dnsWideningTargetPodLabels,
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

	// `packages/sandbox/k8s/manifests/networkpolicy.yaml`'s own DNS rule,
	// reproduced exactly (see this file's `BASELINE_DNS_RULE`, defined below).
	const SHIPPED_BASELINE_DNS_RULE = {
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

	it('a plain NetworkPolicy granting unrestricted kube-dns:53 widens a DNS-narrowed translation', async () => {
		const decision = await decideAgainstNarrowedDns({ dnsNames: true }, [
			{
				metadata: { name: 'namzu-sandbox-baseline' },
				spec: {
					podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
					policyTypes: ['Egress'],
					egress: [SHIPPED_BASELINE_DNS_RULE],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
		expect(decision.refusal?.summary).toContain('namzu-sandbox-baseline')
		expect(decision.refusal?.summary).toMatch(/no DNS-name restriction/)
	})

	it('the same plain NetworkPolicy does NOT widen an unnarrowed (or non-DNS-narrowed) translation', async () => {
		const decision = await decideAgainstNarrowedDns({ ports: [443] }, [
			{
				metadata: { name: 'namzu-sandbox-baseline' },
				spec: {
					podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
					policyTypes: ['Egress'],
					egress: [SHIPPED_BASELINE_DNS_RULE],
				},
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('a second CiliumNetworkPolicy with no rules.dns restriction also widens it', async () => {
		const decision = await decideAgainstNarrowedDns(
			{ dnsNames: true },
			[],
			[
				{
					metadata: { name: 'unrestricted-dns' },
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

	it('a second CiliumNetworkPolicy with a matchPattern DNS rule also widens it — a wildcard is read as unrestricted', async () => {
		const decision = await decideAgainstNarrowedDns(
			{ dnsNames: true },
			[],
			[
				{
					metadata: { name: 'wildcard-dns' },
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
										ports: [{ port: '53', protocol: 'ANY' }],
										rules: { dns: [{ matchPattern: '*' }] },
									},
								],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})

	it('a second CiliumNetworkPolicy narrowed to the same (or a subset of the) names does NOT widen it', async () => {
		const decision = await decideAgainstNarrowedDns(
			{ dnsNames: true },
			[],
			[
				{
					metadata: { name: 'same-names' },
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
										ports: [{ port: '53', protocol: 'ANY' }],
										rules: { dns: [{ matchName: 'github.com' }] },
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

	it('a second CiliumNetworkPolicy naming an extra name beyond our own narrowed set still widens it', async () => {
		const decision = await decideAgainstNarrowedDns(
			{ dnsNames: true },
			[],
			[
				{
					metadata: { name: 'extra-name' },
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
										ports: [{ port: '53', protocol: 'ANY' }],
										rules: {
											dns: [{ matchName: 'github.com' }, { matchName: 'evil.example' }],
										},
									},
								],
							},
						],
					},
				},
			],
		)
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
	})

	it('a plain NetworkPolicy reaching the WHOLE kube-system namespace (broader than kube-dns alone) still widens a DNS-narrowed translation', async () => {
		// This is `CLUSTER_DNS_EGRESS_RULE` — `deny-all`'s own DNS rule — applied
		// under `engine: 'cilium'` beside a DNS-narrowed `static` policy. Wider
		// reachability does not change the finding: a plain rule still cannot
		// express the L7 restriction, so it still resolves every name.
		const decision = await decideAgainstNarrowedDns({ dnsNames: true }, [
			{
				metadata: { name: 'namespace-wide-dns' },
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
							ports: [{ protocol: 'UDP', port: 53 }],
						},
					],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('policy-widens-egress')
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
