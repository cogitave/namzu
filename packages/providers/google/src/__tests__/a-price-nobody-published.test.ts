import { describe, expect, it, vi } from 'vitest'

import { GoogleProvider } from '../client.js'

/**
 * A two-row price table met a listing of every model the vendor serves.
 *
 * `PRICES` holds the two models this driver was given rates for, and
 * `listModels` offers whatever the API returns. The `?? 0` that bridged the
 * two did not say "no rate" for anything outside the table — it said the model
 * was free, on every row of the menu, which is a claim about a bill nobody
 * made. Gemini's rates are published; this driver simply was not given them,
 * and absence is the answer that says so. See `ModelInfo.inputPrice`.
 */

/** The listing shape `listModels` reads, with only the fields it uses. */
function listingTier(): typeof globalThis.fetch {
	return vi.fn<typeof globalThis.fetch>().mockResolvedValue(
		Response.json({
			models: [
				{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
				{ name: 'models/gemini-3-ultra', supportedGenerationMethods: ['generateContent'] },
			],
		}),
	)
}

describe('a model outside the price table is unpriced, not free', () => {
	it('carries the rate for a model the table holds', async () => {
		const models = await new GoogleProvider({ apiKey: 'k', fetch: listingTier() }).listModels()
		const flash = models.find((m) => m.id === 'gemini-2.5-flash')

		expect(flash?.inputPrice).toBe(0.3)
		expect(flash?.outputPrice).toBe(2.5)
	})

	it('omits the rate for a model the table does not hold', async () => {
		const models = await new GoogleProvider({ apiKey: 'k', fetch: listingTier() }).listModels()
		const ultra = models.find((m) => m.id === 'gemini-3-ultra')

		expect(ultra).toBeDefined()
		// The id is real and the listing is real. Only the rate is missing, and
		// it is missing rather than zero.
		expect(ultra).not.toHaveProperty('inputPrice')
		expect(ultra).not.toHaveProperty('outputPrice')
	})

	it('keeps the window and the effort menu on a model it cannot price', async () => {
		// The three facts are independent. Dropping two of them because the
		// third is unknown would leave the menu less useful than before, and
		// the operator with no way to see that anything was dropped.
		const models = await new GoogleProvider({ apiKey: 'k', fetch: listingTier() }).listModels()
		const ultra = models.find((m) => m.id === 'gemini-3-ultra')

		expect(ultra).toHaveProperty('supportsToolUse', true)
		expect(ultra).toHaveProperty('supportsStreaming', true)
	})
})

describe('the signed-in branch lists only models it prices', () => {
	it('carries a rate for every row it offers', async () => {
		// This branch enumerates the table's own keys, so every row is priced
		// by construction. Asserted because it is the branch where a reader
		// could reasonably assume the `?? 0` was harmless — and the count is
		// checked rather than the value, so a table that grows a row that
		// cannot be priced fails here rather than on a user's menu.
		const models = await new GoogleProvider({
			getAccessToken: async () => 'token',
			fetch: vi.fn<typeof globalThis.fetch>(),
		}).listModels()

		expect(models.length).toBeGreaterThan(0)
		for (const model of models) {
			expect(typeof model.inputPrice, `${model.id} input`).toBe('number')
			expect(typeof model.outputPrice, `${model.id} output`).toBe('number')
		}
	})
})
