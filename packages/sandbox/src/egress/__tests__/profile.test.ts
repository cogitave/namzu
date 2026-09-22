import { describe, expect, it } from 'vitest'

import { translateEgressPolicy } from '../../backends/kubernetes/egress-policy.js'
import {
	type SandboxEgressProfile,
	SandboxEgressProfileError,
	defineEgressProfile,
	egressPolicyFromProfile,
	egressProfileAllowsPort,
	egressProfileCoversEntry,
	egressProfilePortsFor,
	kubernetesEgressFromProfile,
} from '../profile.js'

function refusal(run: () => unknown): SandboxEgressProfileError {
	try {
		run()
	} catch (error) {
		expect(error).toBeInstanceOf(SandboxEgressProfileError)
		return error as SandboxEgressProfileError
	}
	throw new Error('expected a SandboxEgressProfileError, and nothing was thrown')
}

describe('defineEgressProfile — validation', () => {
	it.each([
		['', 'empty'],
		['Upper', 'uppercase'],
		['-lead', 'leading dash'],
		['a'.repeat(64), 'longer than 63'],
		['has.dot', 'a dot'],
	])('refuses the name %j (%s)', (name) => {
		const error = refusal(() => defineEgressProfile({ name, hosts: [] }))
		expect(error.code).toBe('invalid-name')
		expect(error.path).toBe('name')
	})

	it.each([
		['*', 'the allow-everything wildcard'],
		['*.example.com', 'a glob'],
		['https://api.example.com', 'a scheme'],
		['api.example.com/v1', 'a path'],
		['api.example.com:443', 'a port suffix'],
		['10.0.0.1', 'an IPv4 literal'],
		['[::1]', 'an IPv6 literal'],
		['.com', 'a whole top-level domain'],
		['.', 'a bare dot'],
		['', 'an empty host'],
	])('refuses the host %j (%s), naming its path', (host) => {
		const error = refusal(() =>
			defineEgressProfile({ name: 'p', hosts: [{ host: 'ok.example.com' }, { host }] }),
		)
		expect(error.code).toBe('invalid-host')
		expect(error.path).toBe('hosts[1].host')
	})

	it.each([
		[[0], 'hosts[0].ports[0]'],
		[[65536], 'hosts[0].ports[0]'],
		[[443, 1.5], 'hosts[0].ports[1]'],
		[[443, 443], 'hosts[0].ports[1]'],
		[[], 'hosts[0].ports'],
	])('refuses ports %j at %s', (ports, path) => {
		const error = refusal(() =>
			defineEgressProfile({ name: 'p', hosts: [{ host: 'a.example.com', ports }] }),
		)
		expect(error.code).toBe('invalid-port')
		expect(error.path).toBe(path)
	})

	it('refuses an exact duplicate host, after normalisation', () => {
		const error = refusal(() =>
			defineEgressProfile({
				name: 'p',
				hosts: [{ host: 'api.example.com' }, { host: 'API.Example.com.' }],
			}),
		)
		expect(error.code).toBe('duplicate-host')
		expect(error.path).toBe('hosts[1].host')
	})

	it('accepts an overlapping, non-identical pair, which the union rule defines', () => {
		expect(() =>
			defineEgressProfile({
				name: 'p',
				hosts: [
					{ host: 'api.example.com', ports: [443] },
					{ host: '.example.com', ports: [8443] },
				],
			}),
		).not.toThrow()
	})

	it('normalises and freezes: lowercase, no trailing dot, sorted ports', () => {
		const profile = defineEgressProfile({
			name: 'gh',
			hosts: [{ host: 'API.GitHub.com.', ports: [8443, 443] }, { host: '.githubusercontent.com' }],
		})
		expect(profile).toEqual({
			name: 'gh',
			hosts: [{ host: 'api.github.com', ports: [443, 8443] }, { host: '.githubusercontent.com' }],
		})
		expect(Object.isFrozen(profile)).toBe(true)
		expect(Object.isFrozen(profile.hosts)).toBe(true)
		expect(Object.isFrozen(profile.hosts[0])).toBe(true)
		expect(Object.isFrozen(profile.hosts[0]?.ports)).toBe(true)
	})

	it('accepts no hosts, which is no egress rather than any', () => {
		const profile = defineEgressProfile({ name: 'none', hosts: [] })
		expect(egressPolicyFromProfile(profile)).toEqual({ kind: 'deny-all' })
	})
})

describe('the port rule — a union over every matching rule', () => {
	const overlapping = defineEgressProfile({
		name: 'p',
		hosts: [
			{ host: 'api.example.com', ports: [443] },
			{ host: '.example.com', ports: [8443] },
			{ host: 'open.example.org' },
		],
	})

	it('gives a host matched by two rules the ports of both', () => {
		expect(egressProfilePortsFor(overlapping, 'api.example.com')).toEqual([443, 8443])
		expect(egressProfileAllowsPort(overlapping, 'api.example.com', 443)).toBe(true)
		expect(egressProfileAllowsPort(overlapping, 'api.example.com', 8443)).toBe(true)
		expect(egressProfileAllowsPort(overlapping, 'api.example.com', 22)).toBe(false)
	})

	it('gives a host matched only by the domain rule that rule alone', () => {
		expect(egressProfilePortsFor(overlapping, 'www.example.com')).toEqual([8443])
		expect(egressProfileAllowsPort(overlapping, 'www.example.com', 443)).toBe(false)
	})

	it('treats a matching rule without ports as every port', () => {
		expect(egressProfilePortsFor(overlapping, 'open.example.org')).toBe('any')
		expect(egressProfileAllowsPort(overlapping, 'open.example.org', 22)).toBe(true)
	})

	it('allows nothing for a host no rule matches', () => {
		expect(egressProfilePortsFor(overlapping, 'elsewhere.test')).toEqual([])
		expect(egressProfileAllowsPort(overlapping, 'elsewhere.test', 443)).toBe(false)
	})

	it('lets a portless rule win over a narrower one for the same host', () => {
		const profile = defineEgressProfile({
			name: 'p',
			hosts: [{ host: 'api.example.com', ports: [443] }, { host: '.example.com' }],
		})
		expect(egressProfileAllowsPort(profile, 'api.example.com', 22)).toBe(true)
	})
})

describe('egressProfileCoversEntry — an allowlist entry inside the profile', () => {
	const profile = defineEgressProfile({
		name: 'p',
		hosts: [{ host: 'api.example.com' }, { host: '.example.org' }],
	})

	it.each([
		['api.example.com', true],
		['API.example.com.', true],
		['www.example.com', false],
		['.api.example.com', false],
		['example.org', true],
		['a.b.example.org', true],
		['.example.org', true],
		['.sub.example.org', true],
		['.org', false],
		['.xexample.org', false],
	])('%j → %s', (entry, covered) => {
		expect(egressProfileCoversEntry(profile, entry)).toBe(covered)
	})
})

describe('kubernetesEgressFromProfile — the existing config, nothing new', () => {
	const github: SandboxEgressProfile = {
		name: 'github',
		hosts: [{ host: 'github.com' }, { host: '.githubusercontent.com' }],
	}

	it('is byte-identical to a hand-written static config when the label is off', () => {
		expect(kubernetesEgressFromProfile(github, { engine: 'cilium' })).toEqual({
			policy: { kind: 'static', allowedHosts: ['github.com', '.githubusercontent.com'] },
			engine: 'cilium',
		})
	})

	it('is a hand-written deny-all for a profile with no hosts', () => {
		expect(kubernetesEgressFromProfile({ name: 'none', hosts: [] })).toEqual({
			policy: { kind: 'deny-all' },
		})
	})

	it('adds the profile label only on an explicit opt-in', () => {
		expect(
			kubernetesEgressFromProfile(github, {
				engine: 'cilium',
				profileLabel: true,
				profileLabelKey: 'sandbox.users.io/egress-profile',
			}),
		).toEqual({
			policy: { kind: 'static', allowedHosts: ['github.com', '.githubusercontent.com'] },
			engine: 'cilium',
			profile: 'github',
			profileLabelKey: 'sandbox.users.io/egress-profile',
		})
	})

	it('forwards verify, the policy name and DNS narrowing', () => {
		expect(
			kubernetesEgressFromProfile(github, {
				engine: 'cilium',
				verify: 'named-object-only',
				networkPolicyName: 'my-egress',
				dnsNames: true,
			}),
		).toEqual({
			policy: { kind: 'static', allowedHosts: ['github.com', '.githubusercontent.com'] },
			engine: 'cilium',
			verify: 'named-object-only',
			networkPolicyName: 'my-egress',
			ciliumNarrowing: { dnsNames: true },
		})
	})

	it('turns ports into hostPorts keyed by the host as written, under cilium', () => {
		expect(
			kubernetesEgressFromProfile(
				{
					name: 'p',
					hosts: [
						{ host: 'api.example.com', ports: [443] },
						{ host: '.example.com', ports: [8443] },
						{ host: 'open.example.org' },
					],
				},
				{ engine: 'cilium' },
			),
		).toEqual({
			policy: {
				kind: 'static',
				allowedHosts: ['api.example.com', '.example.com', 'open.example.org'],
			},
			engine: 'cilium',
			ciliumNarrowing: { hostPorts: { 'api.example.com': [443], '.example.com': [8443] } },
		})
	})

	it('refuses ports without the cilium engine, naming the rule', () => {
		const error = refusal(() =>
			kubernetesEgressFromProfile({ name: 'p', hosts: [{ host: 'a.example.com', ports: [443] }] }),
		)
		expect(error.code).toBe('unsupported')
		expect(error.path).toBe('hosts[0].ports')
		expect(error.backend).toBe('kubernetes')
	})

	it('refuses DNS narrowing on a profile with no hosts, rather than ignoring it', () => {
		const error = refusal(() =>
			kubernetesEgressFromProfile({ name: 'none', hosts: [] }, { dnsNames: true }),
		)
		expect(error.code).toBe('unsupported')
		expect(error.path).toBe('enforcement.dnsNames')
	})

	it('refuses a label key with no label to write under it', () => {
		const error = refusal(() =>
			kubernetesEgressFromProfile(github, { engine: 'cilium', profileLabelKey: 'x.io/p' }),
		)
		expect(error.code).toBe('conflicting-policy')
		expect(error.path).toBe('enforcement.profileLabelKey')
	})

	it('validates the profile it is handed', () => {
		expect(() => kubernetesEgressFromProfile({ name: 'p', hosts: [{ host: '*' }] })).toThrow(
			SandboxEgressProfileError,
		)
	})
})

describe('the union rule, on both backends', () => {
	it('emits one Cilium rule per profile rule, so Cilium unions them as the proxy does', async () => {
		const profile = defineEgressProfile({
			name: 'p',
			hosts: [
				{ host: 'api.example.com', ports: [443] },
				{ host: '.example.com', ports: [8443] },
			],
		})
		const config = kubernetesEgressFromProfile(profile, { engine: 'cilium' })
		const translated = await translateEgressPolicy(
			config.policy,
			'cilium',
			{ namespace: 'ns', name: 'namzu-task-egress', sandboxTemplateName: 'namzu-task' },
			config.ciliumNarrowing,
		)
		const spec = (translated.manifest as { spec: { egress: unknown[] } }).spec
		// The DNS rule first, then one rule per profile rule. `api.example.com`
		// is selected by both host rules, so Cilium admits it on 443 and 8443:
		// exactly what `egressProfileAllowsPort` says the proxy admits.
		expect(spec.egress.slice(1)).toEqual([
			{
				toFQDNs: [{ matchName: 'api.example.com' }],
				toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
			},
			{
				toFQDNs: [{ matchName: 'example.com' }, { matchPattern: '*.example.com' }],
				toPorts: [{ ports: [{ port: '8443', protocol: 'TCP' }] }],
			},
		])
		expect(egressProfilePortsFor(profile, 'api.example.com')).toEqual([443, 8443])
	})
})
