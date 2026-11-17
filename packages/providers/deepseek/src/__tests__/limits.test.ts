import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekProvider } from '../client.js'
import { parseBalance } from '../limits.js'

const NOW = 1_800_000_000_000

// The documented body: amounts are decimal strings, one entry per currency.
const real = {
	is_available: true,
	balance_infos: [
		{
			currency: 'CNY',
			total_balance: '110.00',
			granted_balance: '10.00',
			topped_up_balance: '100.00',
		},
	],
}

describe('parseBalance', () => {
	it('reads the balance as a number with its currency', () => {
		expect(parseBalance(real, NOW)).toEqual({
			credit: { currency: 'CNY', remaining: 110 },
			asOf: NOW,
		})
	})

	it('takes the first entry that reads', () => {
		const out = parseBalance(
			{
				balance_infos: [
					{ currency: 'USD', total_balance: 'n/a' },
					{ currency: 'CNY', total_balance: '3.5' },
				],
			},
			NOW,
		)
		expect(out?.credit).toEqual({ currency: 'CNY', remaining: 3.5 })
	})

	it('reports nothing on any mismatch, never a zero', () => {
		for (const body of [
			null,
			'text',
			{},
			{ balance_infos: [] },
			{ balance_infos: 'x' },
			{ balance_infos: [{ currency: 'USD', total_balance: 110 }] },
			{ balance_infos: [{ total_balance: '1.00' }] },
			{ balance_infos: [{ currency: 'USD', total_balance: '' }] },
			{ balance_infos: [{ currency: 'USD', total_balance: '-4' }] },
		])
			expect(parseBalance(body, NOW)).toBeUndefined()
	})
})

describe('DeepSeekProvider.readLimits', () => {
	afterEach(() => vi.unstubAllGlobals())
	const reply = (body: unknown, ok = true) =>
		vi.fn(async (..._args: unknown[]) => ({ ok, json: async () => body }) as unknown as Response)

	it('asks the vendor host once and reads the balance', async () => {
		const fetcher = reply(real)
		vi.stubGlobal('fetch', fetcher)
		const out = await new DeepSeekProvider({ apiKey: 'k' }).readLimits()
		expect(out?.credit).toEqual({ currency: 'CNY', remaining: 110 })
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/user/balance')
	})

	it('never sends the key to another host', async () => {
		const fetcher = reply(real)
		vi.stubGlobal('fetch', fetcher)
		const out = await new DeepSeekProvider({
			apiKey: 'k',
			baseURL: 'https://proxy.example/v1',
		}).readLimits()
		expect(out).toBeUndefined()
		expect(fetcher).not.toHaveBeenCalled()
	})

	it('reports nothing when the request fails or the body is wrong', async () => {
		vi.stubGlobal('fetch', reply({}, false))
		expect(await new DeepSeekProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new Error('offline'))),
		)
		expect(await new DeepSeekProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
		vi.stubGlobal('fetch', reply({ balance_infos: 'x' }))
		expect(await new DeepSeekProvider({ apiKey: 'k' }).readLimits()).toBeUndefined()
	})
})
