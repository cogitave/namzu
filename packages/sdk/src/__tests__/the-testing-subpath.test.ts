import { describe, expect, it } from 'vitest'

/**
 * `@namzu/sdk/testing` used to point straight at the checkpoint-store
 * file. A second suite would have had to move that file's export or claim
 * a subpath of its own, and neither is a decision a consumer should
 * absorb — so the subpath now points at a barrel.
 *
 * The move is invisible when it works and silently breaking when it does
 * not: every existing `import { defineCheckpointStoreConformance } from
 * '@namzu/sdk/testing'` resolves through the new file, and nothing else in
 * the repository would notice if the barrel dropped it.
 */

describe('the testing subpath', () => {
	it('still exports the checkpoint-store contract it always did', async () => {
		const testing = await import('../testing.js')

		expect(typeof testing.defineCheckpointStoreConformance).toBe('function')
		expect(typeof testing.CHECKPOINT_STORE_CONTRACT_VERSION).toBe('number')
	})

	it('exports the driver contract beside it', async () => {
		const testing = await import('../testing.js')

		expect(typeof testing.defineProviderDriverConformance).toBe('function')
		expect(typeof testing.PROVIDER_DRIVER_CONTRACT_VERSION).toBe('number')
	})

	it('exports deterministic valid entity ids for consumer fixtures', async () => {
		const testing = await import('../testing.js')

		expect(testing.fixtureId.run('consumer')).toBe(testing.fixtureId.run('consumer'))
		expect(testing.fixtureId.run('consumer')).not.toBe(testing.fixtureId.run('other'))
		expect(testing.fixtureId.run('consumer')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
	})
})
