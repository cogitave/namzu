import { describe, expect, it } from 'vitest'

import { ZERO_COST } from '../../constants/limits.js'
import { accumulateUnpricedCost, calculateCost, describeCost } from '../../utils/cost.js'
import { VENDOR_RATES, normaliseModelId, resolveModelPricing } from '../index.js'

const usage = (over: Partial<Record<string, number>> = {}) => ({
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
	...over,
})

describe('golden rates', () => {
	// Pinned so a regeneration that silently moves a rate goes red. Written as
	// literals rather than read back out of the catalogue: asserting
	// `resolve(x).inputCostPer1M === catalogue.get(x).inputCostPer1M` compares
	// the table with itself and passes against any value at all.
	//
	// A failure here is not necessarily a bug — a vendor may genuinely have
	// repriced. It means somebody has to look, which is the whole job of a
	// pinned value, and the fix is to change this file in the same commit as
	// `rates.source.json` so the two moved together deliberately.
	it.each([
		['anthropic', 'claude-opus-5', 5, 25, 0.5, 6.25],
		['anthropic', 'claude-haiku-4-5', 1, 5, 0.1, 1.25],
		['openai', 'gpt-4o', 2.5, 10, 1.25, undefined],
	])('%s/%s is priced at %d in, %d out', (provider, model, input, output, read, write) => {
		const pricing = resolveModelPricing(provider, model)
		expect(pricing).toBeDefined()
		expect(pricing?.inputCostPer1M).toBe(input)
		expect(pricing?.outputCostPer1M).toBe(output)
		expect(pricing?.cache?.readCostPer1M).toBe(read)
		expect(pricing?.cache?.writeCostPer1M).toBe(write)
	})

	it('carries a cache rate for every metered model, since the arithmetic reads one', () => {
		// The two cache numbers exist only if something multiplies them. This
		// is what keeps a future row from being added with two rates and
		// quietly pricing its cache reads at the full input rate.
		for (const vendor of VENDOR_RATES) {
			if (vendor.unmetered) continue
			for (const [id, pricing] of vendor.models) {
				expect(pricing.cache, `${vendor.providerId}/${id}`).toBeDefined()
				expect(typeof pricing.cache?.readCostPer1M).toBe('number')
			}
		}
	})
})

describe('resolution', () => {
	it('prices a dated snapshot at its family rate', () => {
		expect(normaliseModelId('claude-opus-5-20260101')).toBe('claude-opus-5')
		expect(resolveModelPricing('anthropic', 'claude-opus-5-20260101')?.inputCostPer1M).toBe(5)
		// The other suffix shape vendors ship.
		expect(resolveModelPricing('anthropic', 'claude-opus-5@20260101')?.inputCostPer1M).toBe(5)
	})

	it('refuses a near miss instead of pricing it from the neighbouring row', () => {
		// `claude-opus-5x` PREFIXES nothing and is prefixed BY nothing, but a
		// substring or longest-prefix matcher — which is what the neighbouring
		// context-window table uses — would happily resolve it through
		// `claude-opus-5`. Here that is a wrong bill, not a stale window.
		expect(resolveModelPricing('anthropic', 'claude-opus-5x')).toBeUndefined()
		expect(resolveModelPricing('openai', 'gpt-4o-audio')).toBeUndefined()
	})

	it('separates a known-free driver from an unknown one', () => {
		// The distinction this whole change is about, at the resolver.
		const free = resolveModelPricing('ollama', 'llama3.1:8b')
		expect(free).toEqual({ inputCostPer1M: 0, outputCostPer1M: 0 })

		const unknown = resolveModelPricing('bedrock', 'anthropic.claude-opus-5')
		expect(unknown).toBeUndefined()

		// And they are not the same value, which is the assertion that would
		// fail if `undefined` were ever "helpfully" defaulted to a zero card.
		expect(free).not.toEqual(unknown)
	})

	it('prices an unmetered driver whatever model it is asked for', () => {
		// A local driver runs whatever the operator pulled onto the machine, so
		// requiring a row per model would report "cost unknown" about the one
		// case where the cost is known exactly.
		expect(resolveModelPricing('lmstudio', 'some-model-nobody-has-heard-of')).toBeDefined()
		expect(resolveModelPricing('lmstudio', undefined)).toBeDefined()
	})

	it('has no rate for a metered driver asked for no model', () => {
		expect(resolveModelPricing('anthropic', undefined)).toBeUndefined()
	})
})

describe('what a total means', () => {
	it('distinguishes free, unknown and partly-known', () => {
		const free = ZERO_COST
		const unknown = accumulateUnpricedCost(ZERO_COST, usage({ totalTokens: 4210 }))
		const partial = accumulateUnpricedCost(
			calculateCost(usage({ promptTokens: 1_000_000, totalTokens: 1_000_000 }), {
				inputCostPer1M: 5,
				outputCostPer1M: 25,
			}),
			usage({ totalTokens: 900 }),
		)

		// All three have the same totalCost story to a naive reader; only
		// `unpricedTokens` tells them apart.
		expect(free.totalCost).toBe(0)
		expect(unknown.totalCost).toBe(0)
		expect(free.unpricedTokens).toBe(0)
		expect(unknown.unpricedTokens).toBe(4210)
		expect(partial.unpricedTokens).toBe(900)

		expect(describeCost(free)).toBe('$0.00')
		expect(describeCost(unknown)).toBe('unknown (4210 tokens at no known rate)')
		expect(describeCost(partial)).toBe('at least $5.00 (900 tokens at no known rate)')

		// The rendering of "free" and the rendering of "unknown" must not be
		// the same string. A test that only checked `totalCost === 0` would
		// pass against the defect this replaces.
		expect(describeCost(free)).not.toBe(describeCost(unknown))
	})
})
