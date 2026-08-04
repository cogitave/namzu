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

	/**
	 * Output tokens the model spent on internal reasoning.
	 *
	 * A SUBSET of `completionTokens`, not an addition to it — reasoning is
	 * billed as output, so adding these to a total would double-count. Present
	 * so a caller can see what share of a turn went to thinking, which is the
	 * question budgeting and cost attribution actually ask.
	 *
	 * Optional because most drivers do not report it. Absent means unknown,
	 * not zero.
	 */
	reasoningTokens?: number
}

export function accumulateTokenUsage(current: TokenUsage, addition: TokenUsage): TokenUsage {
	return {
		promptTokens: current.promptTokens + addition.promptTokens,
		completionTokens: current.completionTokens + addition.completionTokens,
		totalTokens: current.totalTokens + addition.totalTokens,
		cachedTokens: current.cachedTokens + addition.cachedTokens,
		cacheWriteTokens: current.cacheWriteTokens + addition.cacheWriteTokens,
		// Summed only when at least one side reported it. Coercing absent to
		// zero would turn 'this driver does not tell us' into 'it spent none',
		// and a run mixing a reporting driver with a silent one would read as
		// though the silent turns did no thinking.
		...(current.reasoningTokens !== undefined || addition.reasoningTokens !== undefined
			? { reasoningTokens: (current.reasoningTokens ?? 0) + (addition.reasoningTokens ?? 0) }
			: {}),
	}
}

/**
 * Merge two usage snapshots seen WITHIN a single streamed turn. Provider usage
 * frames over one stream are cumulative/monotonic (input set once early, output
 * grows), but a late frame can OMIT a field (report 0) — e.g. a
 * `message_delta` may carry only output tokens. A naive last-write-wins
 * (`usage = chunk.usage`) then drops the earlier prompt/cache counts and
 * under-reports the turn. Taking the per-field high-water mark preserves every
 * field. DISTINCT from {@link accumulateTokenUsage}, which SUMS across turns.
 */
export function mergeTokenUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
	const promptTokens = Math.max(current.promptTokens, next.promptTokens)
	const completionTokens = Math.max(current.completionTokens, next.completionTokens)

	return {
		promptTokens,
		completionTokens,
		// `totalTokens` is DERIVED (`input + output`), not independent, so the
		// per-field high-water mark is wrong for it: a provider reports the
		// input on `message_start` and the output on `message_delta`, and each
		// frame's own total covers only the component that frame carried.
		// Maxing those two totals returns the larger COMPONENT, not the sum —
		// 1200 and 350 merge to 1200 instead of 1550, and every completion
		// token vanishes from the run's budget. Take the max of what was
		// reported and what the merged components imply, so the result is
		// monotone and can never under-report.
		totalTokens: Math.max(current.totalTokens, next.totalTokens, promptTokens + completionTokens),
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
