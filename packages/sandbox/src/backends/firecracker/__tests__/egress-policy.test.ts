import { describe, expect, it, vi } from 'vitest'

import type { SandboxBackendOptions } from '../../../index.js'
import { resolveEgressAllowlist } from '../index.js'

/**
 * Omitting the allowlist means "no allowlist to apply", which the
 * orchestrator reads as unrestricted. That makes omission the encoding for
 * `allow-all` and only for `allow-all`.
 *
 * `resolver` used to be omitted too — so two opposite intentions shared one
 * encoding, the tenant-scoped allowlist the variant exists for was silently
 * absent, and the callback that would have produced it was never called
 * anywhere in the repo. Whichever way the orchestrator reads an omitted
 * field, one of the two variants was always mis-enforced, and the one that
 * failed OPEN was the one whose entire purpose is restriction.
 */

const opts = (egress?: SandboxBackendOptions['egress']): SandboxBackendOptions => ({
	workingDirectory: '/w',
	...(egress ? { egress } : {}),
})

describe('each policy gets its own encoding', () => {
	it('allow-all omits the field', async () => {
		expect(await resolveEgressAllowlist(opts({ kind: 'allow-all' }))).toBeUndefined()
	})

	it('deny-all sends an explicitly empty list, not an absent one', async () => {
		expect(await resolveEgressAllowlist(opts({ kind: 'deny-all' }))).toEqual([])
	})

	it('static forwards the hosts as given', async () => {
		expect(
			await resolveEgressAllowlist(opts({ kind: 'static', allowedHosts: ['a.example'] })),
		).toEqual(['a.example'])
	})

	it('resolver calls the callback and forwards what it returned', async () => {
		const resolve = vi.fn(async () => ['tenant-a.example', 'tenant-b.example'])
		expect(await resolveEgressAllowlist(opts({ kind: 'resolver', resolve }))).toEqual([
			'tenant-a.example',
			'tenant-b.example',
		])
		// The callback IS the feature. It was declared and never invoked.
		expect(resolve).toHaveBeenCalledOnce()
	})

	it('never encodes resolver the same way as allow-all', async () => {
		const restrictive = await resolveEgressAllowlist(
			opts({ kind: 'resolver', resolve: async () => ['only-this.example'] }),
		)
		const unrestricted = await resolveEgressAllowlist(opts({ kind: 'allow-all' }))
		expect(restrictive).not.toEqual(unrestricted)
	})

	it('sends an empty resolver result as a real deny-all', async () => {
		// An empty allowlist is a decision, not an absence. Collapsing it
		// back to omission would turn "this tenant may reach nothing" into
		// "this tenant may reach everything".
		expect(
			await resolveEgressAllowlist(opts({ kind: 'resolver', resolve: async () => [] })),
		).toEqual([])
	})

	it('omits the field when the host set no policy at all', async () => {
		expect(await resolveEgressAllowlist(opts())).toBeUndefined()
	})
})

describe('an unknown policy', () => {
	it('refuses rather than defaulting to unrestricted', async () => {
		await expect(resolveEgressAllowlist(opts({ kind: 'something-new' } as never))).rejects.toThrow(
			/Refusing rather than defaulting to unrestricted/,
		)
	})

	it('propagates a failing resolver instead of falling back to open', async () => {
		// A resolver that cannot answer must not become "allow everything".
		await expect(
			resolveEgressAllowlist(
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
