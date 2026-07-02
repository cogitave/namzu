export type AgentStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export function isTerminalStatus(status: AgentStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export interface TokenUsage {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	cachedTokens: number
	cacheWriteTokens: number
}

export function accumulateTokenUsage(current: TokenUsage, addition: TokenUsage): TokenUsage {
	return {
		promptTokens: current.promptTokens + addition.promptTokens,
		completionTokens: current.completionTokens + addition.completionTokens,
		totalTokens: current.totalTokens + addition.totalTokens,
		cachedTokens: current.cachedTokens + addition.cachedTokens,
		cacheWriteTokens: current.cacheWriteTokens + addition.cacheWriteTokens,
	}
}

/**
 * Merge two usage snapshots seen WITHIN a single streamed turn. Provider usage
 * frames over one stream are cumulative/monotonic (input set once early, output
 * grows), but a late frame can OMIT a field (report 0) — e.g. Anthropic's
 * `message_delta` may carry only output tokens. A naive last-write-wins
 * (`usage = chunk.usage`) then drops the earlier prompt/cache counts and
 * under-reports the turn. Taking the per-field high-water mark preserves every
 * field. DISTINCT from {@link accumulateTokenUsage}, which SUMS across turns.
 */
export function mergeTokenUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
	return {
		promptTokens: Math.max(current.promptTokens, next.promptTokens),
		completionTokens: Math.max(current.completionTokens, next.completionTokens),
		totalTokens: Math.max(current.totalTokens, next.totalTokens),
		cachedTokens: Math.max(current.cachedTokens, next.cachedTokens),
		cacheWriteTokens: Math.max(current.cacheWriteTokens, next.cacheWriteTokens),
	}
}

export interface CostInfo {
	inputCostPer1M: number
	outputCostPer1M: number
	totalCost: number
	cacheDiscount: number
}

export interface PlatformError {
	code: string
	message: string
	details?: Record<string, unknown>
	retryable: boolean
}
