import type { CostInfo, TokenUsage } from '../types/common/index.js'

export const ZERO_COST: CostInfo = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
}

export const CHARS_PER_TOKEN = 4

/**
 * Grace window for the best-effort `requestFinalResponse` model call after the
 * run has hit a hard limit or timeout. It uses this fixed budget instead of
 * the (already-exhausted) run deadline so a limit-stopped run can still emit a
 * closing summary. See ses_015 A3.
 */
export const FINAL_RESPONSE_GRACE_MS = 30_000

export const EMPTY_TOKEN_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
