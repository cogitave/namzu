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

export const EMPTY_TOKEN_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
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
