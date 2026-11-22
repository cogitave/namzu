import { defineProviderDriverConformance } from '@namzu/sdk/testing'
import { describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../client.js'
import { CodexProvider } from '../codex.js'

/**
 * The driver contract, run against this driver.
 *
 * The rules live in `@namzu/sdk` rather than here, which is the point:
 * seven packages implemented `LLMProvider` and there was nowhere to write
 * a rule binding all of them, so every provider finding in the audit was a
 * behaviour present in exactly one driver and absent from the other six.
 *
 * A new rule added to the suite arrives here without this file changing.
 * Nothing is asserted locally — a local assertion is how the seven
 * hand-written error-taxonomy tests came to cover the same ground
 * differently.
 */

defineProviderDriverConformance({
	describe,
	it,
	expect,
	label: 'openai',
	registryType: 'openai',
	// The generic default suits this vendor; nothing here needs its own
	// budget. Written down rather than omitted, because the suite requires
	// the decision and an omission is not one.
	retryDefaults: undefined,
	attribution: { kind: 'header' },
	// Constructed with credentials that are syntactically valid and reach
	// nothing. The contract asserts declared shape, not behaviour against a
	// live endpoint — a suite that needed a real key could not run in CI.
	makeProvider: () => new OpenAIProvider({ apiKey: 'sk-conformance' }),
})

/**
 * A driver that has no fast mode for a model refuses the request before any
 * transport, rather than serving standard speed under a fast label.
 */
describe('openai drivers refuse fast mode they cannot honour', () => {
	const params = {
		model: 'gpt-4o',
		messages: [{ role: 'user' as const, content: 'hi' }],
		speed: 'fast' as const,
	}

	it('openai refuses an unlisted model and makes no request', async () => {
		const provider = new OpenAIProvider({ apiKey: 'sk-conformance' })
		const create = vi.fn()
		;(provider as unknown as { client: unknown }).client = {
			chat: { completions: { create } },
		}
		await expect(
			(async () => {
				for await (const _chunk of provider.chatStream(params)) void _chunk
			})(),
		).rejects.toMatchObject({ providerCode: 'fast_mode_unsupported' })
		expect(create).not.toHaveBeenCalled()
	})

	it('codex refuses a model its loaded listing does not offer and makes no request', async () => {
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'conformance-fast',
		})
		const create = vi.fn()
		const get = vi.fn(async () => ({
			models: [{ slug: 'gpt-6.2-sol', additional_speed_tiers: ['fast'] }],
		}))
		;(provider as unknown as { client: unknown }).client = {
			responses: { create },
			get,
		}
		await provider.listModels()
		await expect(
			(async () => {
				for await (const _chunk of provider.chatStream(params)) void _chunk
			})(),
		).rejects.toMatchObject({ providerCode: 'fast_mode_unsupported' })
		expect(create).not.toHaveBeenCalled()
	})
})
