import { describe, expect, it } from 'vitest'

import { resolveModelPricing } from '../../pricing/index.js'
import type { TokenUsage } from '../../types/common/index.js'
import { accumulateTokenUsage } from '../../types/common/index.js'
import { ZERO_COST, accumulateCost, calculateCost } from '../cost.js'

const base: TokenUsage = {
	promptTokens: 1_000_000,
	completionTokens: 0,
	totalTokens: 1_000_000,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const pricing = {
	inputCostPer1M: 2,
	outputCostPer1M: 10,
	webSearchCostPer1000: 10,
}

describe('hosted web searches', () => {
	it('are priced per request on top of tokens', () => {
		const cost = calculateCost({ ...base, webSearchRequests: 3 }, pricing)
		expect(cost.totalCost).toBeCloseTo(2 + 0.03, 10)
		expect(cost.unpricedTokens).toBe(0)
	})

	it('are not multiplied by fast mode', () => {
		const cost = calculateCost(
			{ ...base, webSearchRequests: 100, speed: 'fast' },
			{ ...pricing, fastMultiplier: 2 },
		)
		expect(cost.totalCost).toBeCloseTo(4 + 1, 10)
	})

	it('add nothing when the card has no search price', () => {
		const cost = calculateCost(
			{ ...base, webSearchRequests: 3 },
			{ inputCostPer1M: 2, outputCostPer1M: 10 },
		)
		expect(cost.totalCost).toBeCloseTo(2, 10)
	})

	it('are summed across calls, as work done', () => {
		const sum = accumulateTokenUsage(
			{ ...base, webSearchRequests: 1 },
			{ ...base, webSearchRequests: 2 },
		)
		expect(sum.webSearchRequests).toBe(3)
		expect(accumulateTokenUsage(base, base).webSearchRequests).toBeUndefined()
		const total = accumulateCost(ZERO_COST, { ...base, webSearchRequests: 5 }, pricing)
		expect(total.totalCost).toBeCloseTo(2 + 0.05, 10)
	})

	it('are priced by the catalogue for the vendor that bills them', () => {
		expect(resolveModelPricing('anthropic', 'claude-sonnet-5-5')?.webSearchCostPer1000).toBe(10)
		expect(resolveModelPricing('openai', 'gpt-5')?.webSearchCostPer1000).toBeUndefined()
	})
})

describe('service tiers', () => {
	it('price the standard tier and an unreported one the same', () => {
		expect(calculateCost({ ...base, serviceTier: 'standard' }, pricing).totalCost).toBe(2)
		expect(calculateCost(base, pricing).totalCost).toBe(2)
	})

	it.each(['default', 'auto'])('prices a compatible endpoint reporting %s as standard', (tier) => {
		expect(calculateCost({ ...base, serviceTier: tier }, pricing).totalCost).toBe(2)
	})

	it.each(['priority', 'batch'])('report %s tokens as unpriced, not as standard', (tier) => {
		const cost = calculateCost({ ...base, serviceTier: tier }, pricing)
		expect(cost.totalCost).toBe(0)
		expect(cost.unpricedTokens).toBe(1_000_000)
	})

	it('are a per-call fact and are not summed', () => {
		const sum = accumulateTokenUsage(
			{ ...base, serviceTier: 'priority', inferenceGeo: 'us' },
			{ ...base, serviceTier: 'standard' },
		)
		expect(sum.serviceTier).toBeUndefined()
		expect(sum.inferenceGeo).toBeUndefined()
	})
})
