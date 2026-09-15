/**
 * Controls this backend is asked for and cannot apply, refused rather than
 * dropped.
 *
 * `env` is the one worth reading twice. A SandboxClaim CAN carry `spec.env`,
 * so it looks like a control that fits — and a claim that sets it is forced to
 * cold-start instead of adopting a pool sandbox. Accepting it would hand a
 * caller a feature and silently take the warm pool away, with latency as the
 * only symptom. The rest follow the ACI precedent next door: a policy accepted
 * and quietly not enforced is worse than one that is refused.
 */

import { describe, expect, it } from 'vitest'

import type { SandboxBackendOptions } from '../../../index.js'
import {
	assertEnforceable,
	assertRuntimeClassIsApplicable,
	buildKubernetesBackend,
} from '../index.js'

const opts = (extra: Partial<SandboxBackendOptions> = {}): SandboxBackendOptions => ({
	workingDirectory: '/workspace',
	...extra,
})

describe('per-sandbox controls the claim cannot carry', () => {
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
			assertEnforceable(
				opts({
					egress: { kind: 'deny-all' },
					memoryLimitMb: 512,
					maxProcesses: 8,
					env: { A: '1' },
				}),
			)
			expect.unreachable()
		} catch (err) {
			const message = (err as Error).message
			expect(message).toContain('egress')
			expect(message).toContain('memory')
			expect(message).toContain('process')
			expect(message).toContain('environment')
		}
	})

	it('says where the limits do belong', () => {
		expect(() => assertEnforceable(opts({ memoryLimitMb: 512 }))).toThrow(/SandboxTemplate/)
	})

	it('refuses before anything is created, not after', async () => {
		const backend = buildKubernetesBackend({
			access: { server: 'http://127.0.0.1:1', getToken: async () => 't' },
			namespace: 'ns',
			sandboxTemplateName: 'namzu-task',
			warmPoolName: 'pool',
		})
		// The unreachable address is the assertion: a create that got as far as
		// the API server would fail with a connection error instead.
		await expect(
			backend.create({ workingDirectory: '/workspace', memoryLimitMb: 256 }),
		).rejects.toThrow(/cannot enforce per-sandbox/)
	})
})

describe('what it does allow through', () => {
	it('accepts a request that asks for nothing it cannot apply', () => {
		expect(() => assertEnforceable(opts())).not.toThrow()
	})

	it('accepts a timeout, which the caller applies rather than the cluster', () => {
		expect(() => assertEnforceable(opts({ timeoutMs: 30_000 }))).not.toThrow()
	})

	it('treats an empty env bag as asking for nothing', () => {
		expect(() => assertEnforceable(opts({ env: {} }))).not.toThrow()
	})
})

describe('a runtime class the pool path cannot honour', () => {
	it('refuses runtimeClassName together with warmPoolName', () => {
		expect(() =>
			assertRuntimeClassIsApplicable({ warmPoolName: 'pool', runtimeClassName: 'kata-qemu' }),
		).toThrow(/cannot apply runtimeClassName/)
	})

	it('refuses it at construction, so a misconfiguration surfaces during wiring', () => {
		expect(() =>
			buildKubernetesBackend({
				access: { server: 'http://127.0.0.1:1', getToken: async () => 't' },
				namespace: 'ns',
				sandboxTemplateName: 'namzu-task',
				warmPoolName: 'pool',
				runtimeClassName: 'kata-qemu',
			}),
		).toThrow(/SandboxTemplate's podTemplate/)
	})

	it('allows it on the pool-less path, which builds the pod spec itself', () => {
		expect(() => assertRuntimeClassIsApplicable({ runtimeClassName: 'kata-qemu' })).not.toThrow()
	})

	it('allows a pool with no runtime class named', () => {
		expect(() => assertRuntimeClassIsApplicable({ warmPoolName: 'pool' })).not.toThrow()
	})
})
