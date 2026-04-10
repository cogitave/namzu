import { ZERO_COST } from '../constants/limits.js'
import type { CostInfo, TokenUsage } from '../types/common/index.js'

export interface ModelPricing {
	inputCostPer1M: number
	outputCostPer1M: number
}

export { ZERO_COST }

export function calculateCost(
	usage: TokenUsage,
	pricing: ModelPricing,
	cacheDiscount = 0,
): CostInfo {
	const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputCostPer1M
	const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputCostPer1M
	const gross = inputCost + outputCost

	return {
		inputCostPer1M: pricing.inputCostPer1M,
		outputCostPer1M: pricing.outputCostPer1M,
		totalCost: gross - cacheDiscount,
		cacheDiscount,
	}
}

export function accumulateCost(
	current: CostInfo,
	additionalUsage: TokenUsage,
	pricing: ModelPricing,
	cacheDiscount = 0,
): CostInfo {
	const additional = calculateCost(additionalUsage, pricing, cacheDiscount)
	return {
		inputCostPer1M: pricing.inputCostPer1M,
		outputCostPer1M: pricing.outputCostPer1M,
		totalCost: current.totalCost + additional.totalCost,
		cacheDiscount: current.cacheDiscount + additional.cacheDiscount,
	}
}

export function formatCost(usd: number): string {
	if (usd === 0) return '$0.00'
	if (usd < 0.01) return `$${usd.toFixed(4)}`
	return `$${usd.toFixed(2)}`
}
