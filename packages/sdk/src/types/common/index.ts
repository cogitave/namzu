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
	/**
	 * The input rate this total was accumulated at — present only when ONE rate
	 * card describes the whole total.
	 *
	 * Absent means "no single rate describes this", not "zero". Three ways to
	 * get there: nothing has been accumulated yet, the run spanned two
	 * differently-priced models, or part of it was accumulated at no known rate
	 * at all. This is the same contract {@link TokenUsage.reasoningTokens} uses
	 * one field up, for the same reason — a number invented to fill the slot
	 * would be indistinguishable from a measured one.
	 *
	 * The field used to be required, and a run that swapped models reported
	 * whichever card was applied last, which is a claim about the whole total
	 * that was true of only part of it.
	 */
	inputCostPer1M?: number
	/** As {@link CostInfo.inputCostPer1M}, for output tokens. */
	outputCostPer1M?: number
	totalCost: number
	cacheDiscount: number
	/**
	 * Tokens accumulated at no known rate, so `totalCost` does not include what
	 * they cost.
	 *
	 * This exists so a consumer can tell "this run cost nothing" from "nobody
	 * knows what this run cost". Reporting the second as zero is the defect the
	 * price catalogue was added to fix, one level down: a total that is always
	 * zero and a total that is zero because it is unknown look identical, and
	 * `runConfig.costLimitUsd` is enforced against both.
	 *
	 * - `totalCost: 0, unpricedTokens: 0` — the run genuinely cost nothing
	 *   (local inference bills per token exactly never).
	 * - `totalCost: 0, unpricedTokens: 4210` — nobody knows.
	 * - `totalCost: 0.12, unpricedTokens: 900` — partly known; the total is a
	 *   floor, not the answer.
	 *
	 * A count rather than a flag because a run mixes turns: a step can name its
	 * own model and a provider chain can swap members mid-run.
	 */
	unpricedTokens: number
}

export interface PlatformError {
	code: string
	message: string
	details?: Record<string, unknown>
	retryable: boolean
}
