import { describe, expect, it } from 'vitest'

import { OPENROUTER_CAPABILITIES } from '../client.js'

/**
 * This driver does not map attachments, and says so.
 *
 * Shipping without a wire shape is legitimate; claiming one you do not have
 * is not. The runtime reads these flags and warns — or fails under
 * `strictCapabilities` — before the request is built, so the flags are the
 * contract, and what this pins is drift in either direction: flipping a
 * flag without writing the mapping makes the runtime stop warning about
 * images that still vanish, and writing the mapping without flipping the
 * flag makes it keep warning about images that now arrive.
 */

describe('the declared capabilities are the honest ones', () => {
	it('does not claim vision', () => {
		expect(OPENROUTER_CAPABILITIES.supportsVision).toBe(false)
	})

	it('does not claim documents', () => {
		expect(OPENROUTER_CAPABILITIES.supportsDocuments).toBe(false)
	})

	it('claims the tool support it does have', () => {
		expect(OPENROUTER_CAPABILITIES.supportsTools).toBe(true)
		expect(OPENROUTER_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})

	it('claims streaming', () => {
		expect(OPENROUTER_CAPABILITIES.supportsStreaming).toBe(true)
	})

	it('answers every flag the negotiation reads', () => {
		// An absent flag defaults to permissive, so a missing one is not a
		// neutral omission — it is a claim.
		for (const flag of [
			'supportsTools',
			'supportsStreaming',
			'supportsFunctionCalling',
			'supportsVision',
			'supportsDocuments',
		] as const) {
			expect(typeof OPENROUTER_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})
