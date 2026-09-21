import { describe, expect, it } from 'vitest'

/**
 * `@namzu/sdk/testing` is a barrel of contracts a host runs against its own
 * implementation. A contract dropped from the barrel breaks every consumer
 * silently and nothing else in the repository would notice, so each one is
 * pinned here. A custom session log is proved against the session-log suite;
 * the checkpoint-store suite went when checkpoints moved beside the log.
 */

describe('the testing subpath', () => {
	it('exports the session-log contract', async () => {
		const testing = await import('../testing.js')

		expect(typeof testing.defineSessionLogConformance).toBe('function')
		expect(typeof testing.SESSION_LOG_CONTRACT_VERSION).toBe('number')
	})

	it('exports the driver contract beside it', async () => {
		const testing = await import('../testing.js')

		expect(typeof testing.defineProviderDriverConformance).toBe('function')
		expect(typeof testing.PROVIDER_DRIVER_CONTRACT_VERSION).toBe('number')
	})

	it('exports deterministic valid entity ids for consumer fixtures', async () => {
		const testing = await import('../testing.js')

		expect(testing.fixtureId.turn('consumer')).toBe(testing.fixtureId.turn('consumer'))
		expect(testing.fixtureId.turn('consumer')).not.toBe(testing.fixtureId.turn('other'))
		expect(testing.fixtureId.session('consumer')).not.toBe(testing.fixtureId.turn('consumer'))
		expect(testing.fixtureId.turn('consumer')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
	})
})
