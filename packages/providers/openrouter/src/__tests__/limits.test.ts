import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'
import { parseKeyLimits } from '../limits.js'

const NOW = 1_800_000_000_000

// The documented body of GET /key: `data` with limit and limit_remaining null for an uncapped key.
const capped = {
	data: {
		label: 'sk-or-v1-abc...xyz',
		limit: 10,
		limit_remaining: 6.9,
		usage: 3.1,
		usage_daily: 0.2,
		is_free_tier: false,
		effective_budget: null,
	},
}

describe('parseKeyLimits', () => {
	it('reads a capped key in the vendor credits', () => {
		expect(parseKeyLimits(capped, NOW)).toEqual({
			credit: { currency: 'credits', used: 3.1, limit: 10, remaining: 6.9 },
			asOf: NOW,
		})
	})

	it('reads an uncapped key as use only', () => {
		const out = parseKeyLimits({ data: { limit: null, limit_remaining: null, usage: 1.5 } }, NOW)
		expect(out).toEqual({ credit: { currency: 'credits', used: 1.5 }, asOf: NOW })
	})

	it('prefers a budget the vendor names in dollars', () => {
		const out = parseKeyLimits(
			{ data: { usage: 9, effective_budget: { limit_usd: 20, spend_usd: 4, remaining_usd: 16 } } },
			NOW,
		)
		expect(out?.credit).toEqual({ currency: 'USD', limit: 20, used: 4, remaining: 16 })
	})

	it('reports nothing on any mismatch, never a zero', () => {
		for (const body of [
			null,
			[],
			{},
			{ data: null },
			{ data: {} },
			{ data: { usage: '3.1' } },
			{ data: { usage: -1 } },
			{ error: { message: 'No auth' } },
		])
			expect(parseKeyLimits(body, NOW)).toBeUndefined()
	})
})

describe('OpenRouterProvider.readLimits', () => {
	afterEach(() => vi.unstubAllGlobals())
	const reply = (body: unknown, ok = true) =>
		vi.fn(async (..._args: unknown[]) => ({ ok, json: async () => body }) as unknown as Response)

	it('makes one GET of /key and reads it', async () => {
		const fetcher = reply(capped)
		vi.stubGlobal('fetch', fetcher)
		const out = await new OpenRouterProvider({ apiKey: 'k' }).readLimits()
		expect(out?.credit?.limit).toBe(10)
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/key$/)
	})

	it('reports nothing when the request fails or the body is wrong', async () => {
		vi.stubGlobal('fetch', reply({}, false))
		expect(await new OpenRouterProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new Error('offline'))),
		)
		expect(await new OpenRouterProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
		vi.stubGlobal('fetch', reply({ data: {} }))
		expect(await new OpenRouterProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
	})
})
