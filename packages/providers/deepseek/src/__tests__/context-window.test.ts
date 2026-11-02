import { resolveContextWindow, resolveTriggerThreshold } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { DEEPSEEK_CAPABILITIES, DeepSeekProvider } from '../client.js'

/**
 * The vendor documents a 1M context and a 384K output cap for every current
 * model (https://api-docs.deepseek.com/quick_start/pricing). The driver asks
 * the models endpoint first, which may carry `context_window` and
 * `max_output_tokens`, and falls back to those documented limits for the ids
 * it lists. It never reaches the network in these tests: the client is faked.
 */
type ListedModel = { id: string; context_window?: unknown; max_output_tokens?: unknown }

function providerListing(
	data: ListedModel[] | Error,
	baseURL?: string,
): {
	provider: DeepSeekProvider
	list: ReturnType<typeof vi.fn>
} {
	const provider = new DeepSeekProvider({ apiKey: 'test-key', ...(baseURL ? { baseURL } : {}) })
	const list = vi.fn(async () => {
		if (data instanceof Error) throw data
		return { data }
	})
	;(provider as unknown as { client: { models: { list: unknown } } }).client.models.list = list
	return { provider, list }
}

describe('the deepseek driver reports its context window', () => {
	it.each([
		'deepseek-flash',
		'deepseek-v4-flash',
		'deepseek-v4-pro',
		'deepseek-v4-flash-vision-exp',
	])('falls back to the documented one million tokens for %s', async (id) => {
		const { provider } = providerListing([])
		await expect(provider.resolveContextWindow(id)).resolves.toBe(1_000_000)
	})

	it('does not guess for an id it neither lists nor was told about', async () => {
		const { provider } = providerListing([{ id: 'deepseek-flash' }])
		await expect(provider.resolveContextWindow('deepseek-unknown-9')).resolves.toBeUndefined()
	})

	it('prefers the number the models endpoint returns over the documented one', async () => {
		const { provider } = providerListing([
			{ id: 'deepseek-flash', context_window: 2_000_000, max_output_tokens: 500_000 },
			{ id: 'deepseek-unknown-9', context_window: 256_000 },
		])
		await expect(provider.resolveContextWindow('deepseek-flash')).resolves.toBe(2_000_000)
		await expect(provider.resolveContextWindow('deepseek-unknown-9')).resolves.toBe(256_000)
		const models = await provider.listModels()
		expect(models.find((m) => m.id === 'deepseek-flash')).toMatchObject({
			contextWindow: 2_000_000,
			maxOutputTokens: 500_000,
		})
	})

	it('ignores a context_window that is not a positive whole number', async () => {
		const { provider } = providerListing([
			{ id: 'deepseek-flash', context_window: 'big', max_output_tokens: -1 },
			{ id: 'deepseek-v4-pro', context_window: 0 },
		])
		await expect(provider.resolveContextWindow('deepseek-flash')).resolves.toBe(1_000_000)
		await expect(provider.resolveContextWindow('deepseek-v4-pro')).resolves.toBe(1_000_000)
	})

	it('asks the endpoint once, not once per turn', async () => {
		const { provider, list } = providerListing([{ id: 'deepseek-flash' }])
		await provider.resolveContextWindow('deepseek-flash')
		await provider.resolveContextWindow('deepseek-v4-pro')
		expect(list).toHaveBeenCalledTimes(1)
	})

	it('still answers from the documented limits when the listing fails, and asks again next time', async () => {
		const { provider, list } = providerListing(new Error('503'))
		await expect(provider.resolveContextWindow('deepseek-flash')).resolves.toBe(1_000_000)
		await expect(provider.resolveContextWindow('deepseek-flash')).resolves.toBe(1_000_000)
		expect(list).toHaveBeenCalledTimes(2)
	})

	it('declares no driver-wide output cap: the cap belongs to a listed model', () => {
		expect(DEEPSEEK_CAPABILITIES.maxOutputTokens).toBeUndefined()
	})

	it('offers the documented limits only on the vendor host', async () => {
		const gateway = 'https://gateway.example.test/v1'
		const { provider } = providerListing([], gateway)
		await expect(provider.resolveContextWindow('deepseek-flash')).resolves.toBeUndefined()
		const flash = (await provider.listModels()).find((m) => m.id === 'deepseek-flash')
		expect(flash?.contextWindow).toBeUndefined()
		expect(flash?.maxOutputTokens).toBeUndefined()
		const reported = providerListing([{ id: 'deepseek-flash', context_window: 128_000 }], gateway)
		await expect(reported.provider.resolveContextWindow('deepseek-flash')).resolves.toBe(128_000)
		const vendor = providerListing([], 'https://api.deepseek.com/v1')
		await expect(vendor.provider.resolveContextWindow('deepseek-flash')).resolves.toBe(1_000_000)
	})

	it('puts the summary trigger at 967,000 tokens, not 32,000', async () => {
		const { provider } = providerListing([])
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
		const { provider } = providerListing([{ id: 'deepseek-v4-pro' }])
		const models = await provider.listModels()
		for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
			const model = models.find((m) => m.id === id)
			expect(model?.contextWindow).toBe(1_000_000)
			expect(model?.maxOutputTokens).toBe(384_000)
		}
	})

	it('takes images on deepseek-flash and the legacy vision name, text only on the pro model', async () => {
		const { provider } = providerListing([])
		const models = await provider.listModels()
		const modalities = (id: string) => models.find((m) => m.id === id)?.inputModalities
		expect(modalities('deepseek-flash')).toEqual(['text', 'image'])
		expect(modalities('deepseek-v4-flash-vision-exp')).toEqual(['text', 'image'])
		expect(modalities('deepseek-v4-pro')).toEqual(['text'])
	})
})
