import { describe, expect, it } from 'vitest'

import { resolveNetwork } from '../index.js'

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
