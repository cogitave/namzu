import { describe, expect, it } from 'vitest'

import { ZERO_COST } from '../../constants/limits.js'
import type { TokenUsage } from '../../types/common/index.js'
import {
	type ModelPricing,
	accumulateCost,
	accumulateUnpricedCost,
	calculateCost,
} from '../cost.js'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
	...over,
})

/** Cache reads are ADDITIONAL to promptTokens — the shape two drivers here report. */
const ADDITIVE: ModelPricing = {
	inputCostPer1M: 10,
	outputCostPer1M: 100,
	cache: { promptIncludesCacheReads: false, readCostPer1M: 1, writeCostPer1M: 12.5 },
}

/** Cache reads are INSIDE promptTokens — the shape the third one reports. */
const INCLUDED: ModelPricing = {
	inputCostPer1M: 10,
	outputCostPer1M: 100,
	cache: { promptIncludesCacheReads: true, readCostPer1M: 1 },
}

describe('cache-token semantics', () => {
	// The reason the flag exists. Identical usage, identical rates, two
	// drivers — and the correct bill differs. A single implementation that
	// ignored the flag would agree with exactly one of these two and be wrong
	// by the whole cache volume against the other.
	const shared = usage({ promptTokens: 1_000_000, cachedTokens: 1_000_000, totalTokens: 2_000_000 })

	it('charges cache reads on top when the driver excludes them from the prompt count', () => {
		// 1M at $10 + 1M at $1.
		expect(calculateCost(shared, ADDITIVE).totalCost).toBeCloseTo(11, 10)
	})

	it('charges only the uncached remainder when the driver includes them', () => {
		// The 1M prompt tokens ARE the 1M cache reads, so nothing is left at
		// the input rate: 0 at $10 + 1M at $1.
		expect(calculateCost(shared, INCLUDED).totalCost).toBeCloseTo(1, 10)
	})

	it('does not produce a credit when a driver reports more cache reads than prompt tokens', () => {
		const contradictory = usage({ promptTokens: 10, cachedTokens: 1_000_000 })
		expect(calculateCost(contradictory, INCLUDED).totalCost).toBeGreaterThan(0)
	})

	it('prices cache writes, and counts them unpriced when the card has no write rate', () => {
		const wrote = usage({ cacheWriteTokens: 1_000_000, totalTokens: 1_000_000 })

		const rated = calculateCost(wrote, ADDITIVE)
		expect(rated.totalCost).toBeCloseTo(12.5, 10)
		expect(rated.unpricedTokens).toBe(0)

		// A driver that declares it never reports writes and then does is a
		// contradiction. Counting the tokens surfaces it; charging them at some
		// neighbouring rate would bury it in a plausible-looking total.
		const unrated = calculateCost(wrote, INCLUDED)
		expect(unrated.totalCost).toBe(0)
		expect(unrated.unpricedTokens).toBe(1_000_000)
	})

	it('reports the cache saving rather than subtracting it again', () => {
		const read = usage({ cachedTokens: 1_000_000 })
		const cost = calculateCost(read, ADDITIVE)
		// Charged at the read rate: $1. Saved against the input rate: $9.
		expect(cost.totalCost).toBeCloseTo(1, 10)
		expect(cost.cacheDiscount).toBeCloseTo(9, 10)
		// If the discount were subtracted as well, the bill would be -$8.
		expect(cost.totalCost).toBeGreaterThan(0)
	})

	it('leaves cache tokens alone for a two-rate card', () => {
		const twoRate: ModelPricing = { inputCostPer1M: 10, outputCostPer1M: 100 }
		const cost = calculateCost(usage({ promptTokens: 1_000_000, cachedTokens: 500_000 }), twoRate)
		expect(cost.totalCost).toBeCloseTo(10, 10)
		expect(cost.cacheDiscount).toBe(0)
		expect(cost.unpricedTokens).toBe(0)
	})
})

describe('the rate fields describe the whole total or they are absent', () => {
	const cheap: ModelPricing = { inputCostPer1M: 1, outputCostPer1M: 2 }
	const dear: ModelPricing = { inputCostPer1M: 100, outputCostPer1M: 200 }
	const million = usage({ promptTokens: 1_000_000, totalTokens: 1_000_000 })

	it('adopts the card on the first accumulation', () => {
		const one = accumulateCost(ZERO_COST, million, cheap)
		expect(one.inputCostPer1M).toBe(1)
		expect(one.outputCostPer1M).toBe(2)
	})

	it('keeps the card while one card still covers the total', () => {
		const two = accumulateCost(accumulateCost(ZERO_COST, million, cheap), million, cheap)
		expect(two.inputCostPer1M).toBe(1)
		expect(two.totalCost).toBeCloseTo(2, 10)
	})

	it('drops the card when the total spans two of them', () => {
		const mixed = accumulateCost(accumulateCost(ZERO_COST, million, cheap), million, dear)
		// The total is right; no single rate describes it, so neither field
		// claims to. Before this, the last card applied was written over the
		// first, so a $101 total reported itself as priced at $100/M.
		expect(mixed.totalCost).toBeCloseTo(101, 10)
		expect(mixed.inputCostPer1M).toBeUndefined()
		expect(mixed.outputCostPer1M).toBeUndefined()
	})

	it('does not adopt a card over spend that was never priced', () => {
		// The freshness trap. This total has zero cost and no rates, exactly
		// like a brand new one — but it is not fresh, because tokens went by
		// unpriced. Adopting `dear` here would claim it priced those too.
		const afterUnpriced = accumulateUnpricedCost(ZERO_COST, usage({ totalTokens: 5_000 }))
		const then = accumulateCost(afterUnpriced, million, dear)
		expect(then.inputCostPer1M).toBeUndefined()
		expect(then.unpricedTokens).toBe(5_000)
	})

	it('drops the card when the accumulation itself left tokens unpriced', () => {
		const wrote = usage({ promptTokens: 1_000_000, cacheWriteTokens: 100, totalTokens: 1_000_100 })
		const cost = accumulateCost(ZERO_COST, wrote, INCLUDED)
		expect(cost.unpricedTokens).toBe(100)
		expect(cost.inputCostPer1M).toBeUndefined()
	})

	it('carries unpriced tokens forward across a later priced turn', () => {
		const run = accumulateCost(
			accumulateUnpricedCost(ZERO_COST, usage({ totalTokens: 900 })),
			million,
			cheap,
		)
		expect(run.totalCost).toBeCloseTo(1, 10)
		expect(run.unpricedTokens).toBe(900)
	})
})
