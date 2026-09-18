import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * Both answers arrive on this one field, and only one of them used to survive.
 *
 * OpenRouter states each rate as a decimal string of USD per token, and states
 * `"0"` for the models it serves at no charge. So this listing is the only one
 * in the tree where a missing price and a real price of zero are both
 * expressible, and the `?? '0'` that used to be here did not default the first
 * one — it asserted it. Every model whose pricing block was absent was
 * reported as free, which is a claim about a bill, and it is exactly the claim
 * a `(free)` marker on the model menu reads as a fact.
 *
 * Three cases, and the third is the one that must not regress: a published
 * zero is still a price, and `ollama`'s honest zero is the same value for the
 * same reason. See `ModelInfo.inputPrice`.
 */

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' })
}

function listing(
	models: { id: string; pricing?: { prompt: string; completion: string } }[],
): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({
			data: models.map((m) => ({
				id: m.id,
				name: m.id,
				context_length: 200_000,
				top_provider: { max_completion_tokens: 8_192 },
				...(m.pricing ? { pricing: m.pricing } : {}),
			})),
		}),
	})
}

async function list(models: Parameters<typeof listing>[0]) {
	vi.stubGlobal('fetch', listing(models))
	return provider().listModels()
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('a rate OpenRouter did not publish is absent, not zero', () => {
	it('omits both rates for a model whose listing carries no pricing block', async () => {
		const [model] = await list([{ id: 'someone/private-preview' }])

		// `toHaveProperty` would pass on `undefined`, so the check is for the
		// KEY. An absent key is what says "the driver did not know"; a key
		// present and undefined reaches a JSON consumer as `null` and a
		// structured clone as a property that exists.
		expect(model).not.toHaveProperty('inputPrice')
		expect(model).not.toHaveProperty('outputPrice')
	})

	it('still reports the rest of the listing for a model it cannot price', async () => {
		// The omission is about one field. A driver that dropped the model, or
		// its window, because it had no rate would be a worse menu than the
		// one that mispriced it.
		const [model] = await list([{ id: 'someone/private-preview' }])

		expect(model?.id).toBe('someone/private-preview')
		expect(model?.contextWindow).toBe(200_000)
	})
})

describe('a rate OpenRouter did publish is carried', () => {
	it('converts per-token to per-million at the unit the field states', async () => {
		const [model] = await list([
			{
				id: 'anthropic/claude-sonnet-4-6',
				pricing: { prompt: '0.000003', completion: '0.000015' },
			},
		])

		expect(model?.inputPrice).toBe(3)
		expect(model?.outputPrice).toBe(15)
	})

	it('treats a rate that does not parse as unknown rather than as NaN', async () => {
		// The value arrives from the network and this driver multiplies it by a
		// million. `NaN` would propagate through a sum and reach an operator as
		// a total nobody can read, which is a worse answer than "unknown".
		const [model] = await list([
			{ id: 'someone/broken-row', pricing: { prompt: 'free', completion: '' } },
		])

		expect(model).not.toHaveProperty('inputPrice')
		expect(model).not.toHaveProperty('outputPrice')
	})
})

describe('a published zero is a price, not an absence', () => {
	it('carries 0 for a model OpenRouter serves at no charge', async () => {
		// The distinction the whole change is about, asserted at the driver
		// that can produce both answers. This model is free; the one in the
		// first case is merely unknown; and a consumer must be able to tell
		// them apart. `listModels` writing `0` here is correct and stays.
		const [model] = await list([
			{ id: 'meta-llama/llama-3-8b-instruct:free', pricing: { prompt: '0', completion: '0' } },
		])

		expect(model?.inputPrice).toBe(0)
		expect(model?.outputPrice).toBe(0)
	})
})
