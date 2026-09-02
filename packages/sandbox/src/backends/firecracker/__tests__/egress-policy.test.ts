import { describe, expect, it, vi } from 'vitest'

import type { SandboxBackendOptions } from '../../../index.js'
import { resolveNetworkPolicy } from '../index.js'

/**
 * Omission means the caller supplied no policy and preserves the legacy
 * no-NIC request. Every explicit policy gets its own discriminated encoding.
 */

const opts = (egress?: SandboxBackendOptions['egress']): SandboxBackendOptions => ({
	workingDirectory: '/w',
	...(egress ? { egress } : {}),
})

describe('each policy gets its own encoding', () => {
	it('allow-all requests open networking explicitly', async () => {
		expect(await resolveNetworkPolicy(opts({ kind: 'allow-all' }))).toEqual({ mode: 'open' })
	})

	it('deny-all requests no network explicitly', async () => {
		expect(await resolveNetworkPolicy(opts({ kind: 'deny-all' }))).toEqual({ mode: 'none' })
	})

	it('static forwards the hosts as given', async () => {
		expect(
			await resolveNetworkPolicy(opts({ kind: 'static', allowedHosts: ['a.example'] })),
		).toEqual({ mode: 'allowlist', allowedHosts: ['a.example'] })
	})

	it('resolver calls the callback and forwards what it returned', async () => {
		const resolve = vi.fn(async () => ['tenant-a.example', 'tenant-b.example'])
		expect(await resolveNetworkPolicy(opts({ kind: 'resolver', resolve }))).toEqual({
			mode: 'allowlist',
			allowedHosts: ['tenant-a.example', 'tenant-b.example'],
		})
		// The callback IS the feature. It was declared and never invoked.
		expect(resolve).toHaveBeenCalledOnce()
	})

	it('never encodes resolver the same way as allow-all', async () => {
		const restrictive = await resolveNetworkPolicy(
			opts({ kind: 'resolver', resolve: async () => ['only-this.example'] }),
		)
		const unrestricted = await resolveNetworkPolicy(opts({ kind: 'allow-all' }))
		expect(restrictive).not.toEqual(unrestricted)
	})

	it('sends an empty resolver result as a real deny-all', async () => {
		// An empty allowlist is a decision, not an absence. Collapsing it
		// back to omission would turn "this tenant may reach nothing" into
		// "this tenant may reach everything".
		expect(await resolveNetworkPolicy(opts({ kind: 'resolver', resolve: async () => [] }))).toEqual(
			{ mode: 'allowlist', allowedHosts: [] },
		)
	})

	it('omits the field when the host set no policy at all', async () => {
		expect(await resolveNetworkPolicy(opts())).toBeUndefined()
	})
})

describe('an unknown policy', () => {
	it('refuses rather than defaulting to unrestricted', async () => {
		await expect(resolveNetworkPolicy(opts({ kind: 'something-new' } as never))).rejects.toThrow(
			/Refusing rather than defaulting to unrestricted/,
		)
	})

	it('propagates a failing resolver instead of falling back to open', async () => {
		// A resolver that cannot answer must not become "allow everything".
		await expect(
			resolveNetworkPolicy(
				opts({
					kind: 'resolver',
					resolve: async () => {
						throw new Error('directory unreachable')
					},
				}),
			),
		).rejects.toThrow('directory unreachable')
	})
})
