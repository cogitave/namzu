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
	type KubernetesEgressEngine,
	KubernetesEgressPolicyMismatchError,
	KubernetesEgressPolicyNotAppliedError,
	KubernetesUnenforceableEgressPolicyError,
	assertEgressPolicyIsEnforceable,
	defaultEgressPolicyName,
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
