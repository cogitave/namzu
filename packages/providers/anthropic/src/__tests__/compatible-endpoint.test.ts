import { describe, expect, it } from 'vitest'

import { AnthropicProvider, isVendorEndpoint } from '../client.js'

/**
 * A third-party endpoint that speaks this wire gets a plain bearer token and
 * the system prompt as written. The subscription identity is the vendor's own
 * endpoint's business and is never sent anywhere else.
 */
const BASE = 'https://api.example-compatible.test/anthropic'

function headers(provider: AnthropicProvider): Record<string, string> {
	const client = (provider as unknown as { client: { _options?: { defaultHeaders?: unknown } } })
		.client
	return (client._options?.defaultHeaders ?? {}) as Record<string, string>
}

function body(provider: AnthropicProvider, over: Record<string, unknown> = {}) {
	return (
		provider as unknown as {
			buildCreateParams(p: unknown, stream: boolean): Record<string, any>
		}
	).buildCreateParams(
		{
			model: 'deepseek-flash',
			messages: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'hi' },
			],
			...over,
		},
		true,
	)
}

describe('isVendorEndpoint', () => {
	it('is true for no base URL and for the vendor host only', () => {
		expect(isVendorEndpoint(undefined)).toBe(true)
		expect(isVendorEndpoint('https://api.anthropic.com')).toBe(true)
		expect(isVendorEndpoint('https://api.anthropic.com/v1/')).toBe(true)
		expect(isVendorEndpoint(BASE)).toBe(false)
		expect(isVendorEndpoint('https://api.anthropic.com.evil.test')).toBe(false)
		expect(isVendorEndpoint('not a url')).toBe(false)
	})
})

describe('a token sent to a compatible third-party endpoint', () => {
	it('carries no subscription headers and no identity system block', () => {
		const provider = new AnthropicProvider({
			authToken: 'tok',
			baseURL: BASE,
			compatibleEndpoint: true,
		})
		const h = headers(provider)
		expect(h['anthropic-beta']).toBeUndefined()
		expect(h['x-app']).toBeUndefined()
		expect(String(h['User-Agent'] ?? h['user-agent'])).not.toMatch(/claude-code/)
		expect(body(provider).system).toEqual([{ type: 'text', text: 'Be brief.' }])
	})

	it('keeps the subscription identity for a token sent through a proxy unless the caller opts in', () => {
		const provider = new AnthropicProvider({ authToken: 'tok', baseURL: BASE })
		expect(headers(provider)['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
		expect(body(provider).system[0].text).toMatch(/^You are Claude Code/)
	})

	it('keeps the subscription identity on the vendor endpoint, with or without a base URL', () => {
		for (const baseURL of [undefined, 'https://api.anthropic.com']) {
			const provider = new AnthropicProvider({ authToken: 'tok', ...(baseURL ? { baseURL } : {}) })
			expect(headers(provider)['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
			expect(body(provider).system[0].text).toMatch(/^You are Claude Code/)
		}
	})

	it('offers low, high and max for a non-Claude id and sends effort and thinking', () => {
		const provider = new AnthropicProvider({
			authToken: 'tok',
			baseURL: BASE,
			compatibleEndpoint: true,
		})
		expect(provider.reasoningEffortLevelsFor('deepseek-flash')).toEqual(['low', 'high', 'max'])
		const sent = body(provider, { effort: 'max' })
		expect(sent.output_config).toEqual({ effort: 'max' })
	})

	it('lists no vendor models when the catalogue is unreachable', async () => {
		const provider = new AnthropicProvider({
			authToken: 'tok',
			baseURL: BASE,
			compatibleEndpoint: true,
		})
		;(provider as unknown as { client: unknown }).client = {
			models: {
				list: async () => {
					throw new Error('down')
				},
			},
		}
		await expect(provider.listModels()).resolves.toEqual([])
	})

	it('leaves the vendor effort table for Claude ids on the vendor endpoint', () => {
		const provider = new AnthropicProvider({ authToken: 'tok' })
		expect(provider.reasoningEffortLevelsFor('deepseek-flash')).toEqual([])
	})
})
