import { afterEach, describe, expect, it, vi } from 'vitest'

import { OllamaProvider } from '../client.js'

/**
 * The driver whose zero is a fact, and which must not be swept up by the fix.
 *
 * A local server bills per token exactly never, so `0` is the true rate for
 * every model it serves — whatever the operator has pulled onto the machine.
 * This driver reported that before the price fields became optional and it
 * reports it after; the change is about the drivers that wrote the same `0`
 * without knowing it.
 *
 * The rate card says the same thing in its own words, at
 * `packages/sdk/src/pricing/rates.source.json`: an unmetered driver "is priced
 * at zero, which is KNOWN-free and therefore distinct from unknown". These
 * tests are that sentence, at the driver that has to keep earning it.
 */

function provider(): OllamaProvider {
	const fetch = vi.fn().mockResolvedValue(
		Response.json({
			models: [
				{ name: 'llama3.1:8b', model: 'llama3.1:8b', size: 4_700_000_000, digest: 'abc' },
				{ name: 'qwen2.5:72b', model: 'qwen2.5:72b', size: 47_000_000_000, digest: 'def' },
			],
		}),
	)
	return new OllamaProvider({ fetch: fetch as unknown as typeof globalThis.fetch })
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('a local server is free, and says so', () => {
	it('writes 0 for every model it serves rather than omitting the rate', async () => {
		// The whole point. Omitting here would be the same defect inverted:
		// it would report "nobody knows" about the one driver where the
		// answer is known for every model that could ever appear.
		const models = await provider().listModels()

		expect(models.length).toBeGreaterThan(0)
		for (const model of models) {
			expect(model.inputPrice, `${model.id} input`).toBe(0)
			expect(model.outputPrice, `${model.id} output`).toBe(0)
		}
	})

	it('keeps the key present, so 0 is distinguishable from an absent rate', async () => {
		// A consumer telling free from unknown reads presence first. If this
		// driver omitted the field, a menu could not mark its models free at
		// all — and the operator would be unable to see the one case where
		// the cost is known exactly.
		const [model] = await provider().listModels()

		expect(model).toHaveProperty('inputPrice')
		expect(model).toHaveProperty('outputPrice')
		expect(Number.isFinite(model?.inputPrice)).toBe(true)
	})
})
