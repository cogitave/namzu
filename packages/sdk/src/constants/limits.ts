import type { CostInfo, TokenUsage } from '../types/common/index.js'

/**
 * The starting value for a run: nothing accumulated, nothing unpriced.
 *
 * Carries NO rate fields, and that is load-bearing rather than tidy. It is what
 * lets {@link import('../utils/cost.js').accumulateCost} tell "fresh" from
 * "already spans two rate cards" without a separate marker: a fresh total has
 * no rates AND no unpriced tokens AND a zero total, and no accumulated one can
 * have all three.
 *
 * It also stops reading as a rate card of zero. `inputCostPer1M: 0` on a run
 * nobody has priced says the model is free, which was exactly the confusion
 * `unpricedTokens` was added to end.
 */
export const ZERO_COST: CostInfo = {
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}

export const CHARS_PER_TOKEN = 4

export const EMPTY_TOKEN_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
