import { describe, expect, it } from 'vitest'

import { EXTENSION_PUBLISHER_KEYS, ed25519KeyFromRaw, isDevKeyId, trustedKeys } from './keys.js'

describe('the publisher keys this build trusts', () => {
	it('are production keys: a real Ed25519 key, never a dev id, each for one publisher and its own id prefix', () => {
		expect(EXTENSION_PUBLISHER_KEYS.length).toBeGreaterThan(0)
		for (const key of EXTENSION_PUBLISHER_KEYS) {
			expect(isDevKeyId(key.id)).toBe(false)
			expect(key.dev).toBeUndefined()
			expect(() => ed25519KeyFromRaw(key.publicKey)).not.toThrow()
			expect(key.publisher).toMatch(/^[a-z0-9-]+$/)
			expect(key.idPrefixes.length).toBeGreaterThan(0)
			for (const prefix of key.idPrefixes) expect(prefix).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.$/)
		}
		expect(new Set(EXTENSION_PUBLISHER_KEYS.map((k) => k.id)).size).toBe(
			EXTENSION_PUBLISHER_KEYS.length,
		)
	})

	it("include Cogitave's key for com.cogitave ids, trusted in a plain environment", () => {
		const keys = trustedKeys({})
		expect(keys).toContainEqual(
			expect.objectContaining({
				id: 'cogitave-2026',
				publisher: 'cogitave',
				idPrefixes: ['com.cogitave.'],
			}),
		)
	})
})
