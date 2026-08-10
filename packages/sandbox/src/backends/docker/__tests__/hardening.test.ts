import { describe, expect, it } from 'vitest'

import { egressProxyOptions, resolveNetwork } from '../index.js'

/**
 * `EgressPolicy` was accepted by the type, threaded through the options,
 * and silently ignored by this backend. That is worse than not supporting
 * it: a host that set `deny-all` believed the container had no network,
 * and it had whatever `config.network` said.
 */

describe('resolveNetwork', () => {
	it('leaves the configured network alone when no policy is supplied', () => {
		expect(resolveNetwork('bridge', undefined)).toBe('bridge')
	})

	it('enforces deny-all natively', () => {
		// Docker can actually do this one, so there is no excuse for
		// accepting the policy and ignoring it.
		expect(resolveNetwork('bridge', { kind: 'deny-all' })).toBe('none')
	})

	it('allow-all keeps the configured network', () => {
		expect(resolveNetwork('my-bridge', { kind: 'allow-all' })).toBe('my-bridge')
	})

	it('REFUSES a host allowlist rather than silently granting full access', () => {
		// This backend has no proxy to filter through. Downgrading a
		// restrictive policy to "allow everything" is the failure mode that
		// makes a security control worse than useless.
		expect(() =>
			resolveNetwork('bridge', { kind: 'static', allowedHosts: ['example.com'] }),
		).toThrow(/cannot enforce an egress policy/)

		expect(() => resolveNetwork('bridge', { kind: 'resolver', resolve: async () => [] })).toThrow(
			/cannot enforce an egress policy/,
		)
	})

	it('names what it can do, so the failure is actionable', () => {
		expect(() => resolveNetwork('bridge', { kind: 'static', allowedHosts: [] })).toThrow(/deny-all/)
	})
})

/**
 * The knobs a host sets have to arrive at the boundary.
 *
 * Everything past this function needs a running Docker daemon, so a config
 * field that never reached `EgressProxy` would be caught by an operator
 * watching production traffic get denied — with no way to fix it, because the
 * escape hatch they were told to use is the one that went missing.
 */
describe('egressProxyOptions', () => {
	const policy = { kind: 'static', allowedHosts: ['api.example.com'] } as const

	it('carries the inward exemption to the boundary', () => {
		const options = egressProxyOptions({ allowInwardFor: ['inside.example'] }, policy)
		expect(options.allowInwardFor).toEqual(['inside.example'])
	})

	it('leaves it absent when the host named none, so the screen applies', () => {
		// The other half of the same fact: a field populated whatever the host
		// passed would satisfy the case above and say nothing.
		expect(egressProxyOptions({}, policy).allowInwardFor).toBeUndefined()
	})

	it('carries the brokered credentials too', () => {
		const credential = { host: 'api.example.com', header: 'authorization', value: 'real' }
		expect(egressProxyOptions({ brokeredCredentials: [credential] }, policy).credentials).toEqual([
			credential,
		])
	})

	it('resolves the allowlist per call rather than capturing it', async () => {
		// `setNetworkPolicy` swaps the policy on a live sandbox, and a
		// snapshot taken at construction would enforce the policy the sandbox
		// started with for the rest of its life.
		let hosts: string[] = ['first.example']
		const options = egressProxyOptions({}, { kind: 'resolver', resolve: async () => hosts })

		expect(await options.allowedHosts()).toEqual(['first.example'])
		hosts = ['second.example']
		expect(await options.allowedHosts()).toEqual(['second.example'])
	})
})
