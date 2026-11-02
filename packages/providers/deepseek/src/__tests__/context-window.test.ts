import { resolveContextWindow, resolveTriggerThreshold } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { DEEPSEEK_CAPABILITIES, DeepSeekProvider } from '../client.js'

/**
 * The driver states the window the vendor documents (1M tokens, 384K output,
 * https://api-docs.deepseek.com/quick_start/pricing), so the runtime never
 * falls through to the SDK's hand table for these ids.
 */
describe('the deepseek driver reports its context window', () => {
	const provider = new DeepSeekProvider({ apiKey: 'test-key' })

	it.each([
		'deepseek-flash',
		'deepseek-v4-flash',
		'deepseek-v4-pro',
		'deepseek-v4-flash-vision-exp',
	])('resolves %s to one million tokens', async (id) => {
		await expect(provider.resolveContextWindow(id)).resolves.toBe(1_000_000)
	})

	it('does not guess for an id it does not know', async () => {
		await expect(provider.resolveContextWindow('deepseek-unknown-9')).resolves.toBeUndefined()
	})

	it('declares the output cap, so the trigger reserves what the model can write', () => {
		expect(DEEPSEEK_CAPABILITIES.maxOutputTokens).toBe(384_000)
	})

	it('puts the summary trigger at 967,000 tokens, not 32,000', async () => {
		const reported = await provider.resolveContextWindow('deepseek-v4-flash')
		const window = resolveContextWindow(undefined, 'deepseek-v4-flash', reported)
		expect(window).toEqual({ tokens: 1_000_000, source: 'provider' })
		expect(
			Math.floor(
				window.tokens *
					resolveTriggerThreshold(undefined, window.tokens, DEEPSEEK_CAPABILITIES.maxOutputTokens),
			),
		).toBe(967_000)
	})

	it('lists the window and output cap with each known model', async () => {
		const client = (provider as unknown as { client: { models: { list: unknown } } }).client
		client.models.list = async () => ({ data: [{ id: 'deepseek-v4-pro' }] })
		const models = await provider.listModels()
		for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
			const model = models.find((m) => m.id === id)
			expect(model?.contextWindow).toBe(1_000_000)
			expect(model?.maxOutputTokens).toBe(384_000)
		}
	})
})
