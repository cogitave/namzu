import type { CostInfo, TokenUsage } from '../types/common/index.js'

export const ZERO_COST: CostInfo = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
