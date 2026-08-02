import { describe, expect, it } from 'vitest'

import type { SandboxBackendOptions } from '../../../index.js'
import { assertEnforceable } from '../index.js'

/**
 * The claim API rejects every property override that is not a config map,
 * so a memory cap, a process cap, environment variables and an egress
 * policy have nowhere to ride through on this backend. They were accepted
 * and dropped: a host that asked for `deny-all` and 512 MB got full
 * outbound network and no cap, with no error and no warning — from the same
 * call shape that IS enforced on the sibling container backend.
 *
 * Switching backends therefore removed the blast-radius controls silently,
 * which is the worst way to lose them. namzu already holds the norm for
 * this next door: a policy accepted and quietly ignored is worse than one
 * that is refused.
 */

const opts = (extra: Partial<SandboxBackendOptions> = {}): SandboxBackendOptions => ({
	workingDirectory: '/w',
	...extra,
})

describe('controls this backend cannot apply', () => {
	it.each([
		['an egress policy', { egress: { kind: 'deny-all' } as const }],
		['a memory limit', { memoryLimitMb: 512 }],
		['a process limit', { maxProcesses: 32 }],
		['environment variables', { env: { SECRET: 'x' } }],
	])('refuses %s', (_name, extra) => {
		expect(() => assertEnforceable(opts(extra))).toThrow(/cannot enforce per-sandbox/)
	})

	it('names every field it cannot honour, not just the first', () => {
		try {
			assertEnforceable(opts({ egress: { kind: 'deny-all' }, memoryLimitMb: 512, maxProcesses: 8 }))
			expect.unreachable()
		} catch (err) {
			const message = (err as Error).message
			// A host fixing one and hitting the next on the following run
			// learns the shape one failure at a time.
			expect(message).toContain('egress')
			expect(message).toContain('memory')
			expect(message).toContain('process')
		}
	})

	it('says where the limits do belong', () => {
		// Refusing without saying what to do instead is a dead end; these
		// are a property of the pooled profile.
		expect(() => assertEnforceable(opts({ memoryLimitMb: 512 }))).toThrow(/container group profile/)
	})
})

describe('what it does allow through', () => {
	it('accepts a request that asks for nothing it cannot apply', () => {
		expect(() => assertEnforceable(opts())).not.toThrow()
	})

	it('accepts a timeout, which is applied by the caller not the pool', () => {
		expect(() => assertEnforceable(opts({ timeoutMs: 30_000 }))).not.toThrow()
	})

	it('treats an empty env bag as asking for nothing', () => {
		// A host spreading an empty object should not be refused for it.
		expect(() => assertEnforceable(opts({ env: {} }))).not.toThrow()
	})
})
