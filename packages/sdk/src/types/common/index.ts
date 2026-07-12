/**
 * Lifecycle status of a run, as persisted ({@link import('../run/entity.js').Run})
 * and as returned ({@link import('../agent/base.js').BaseAgentResult}).
 *
 * `awaiting_input` is the **suspension**: the run stopped because it needs a
 * decision from outside itself (a tool review, a plan approval, an iteration
 * checkpoint) and cannot make progress until one arrives. It is NOT terminal —
 * an `awaiting_input` run has no `endedAt`, resolves no result, and emits no
 * completion event. It is the one and only way to say "this run is waiting for
 * a human": the domain {@link import('../run/status.js').RunStatus} spells it
 * the same way, the wire (`WireRunStatus`) carries it verbatim, and
 * `RUN_STATUS_TO_A2A` maps it onto A2A's `input-required`.
 */
export type AgentStatus =
	| 'idle'
	| 'pending'
	| 'running'
	| 'awaiting_input'
	| 'completed'
	| 'failed'
	| 'cancelled'

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
