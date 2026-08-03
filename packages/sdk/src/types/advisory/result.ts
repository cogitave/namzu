import type { CostInfo, TokenUsage } from '../common/index.js'

export interface AdvisoryRequest {
	readonly advisorId?: string
	readonly question: string
	readonly domain?: string
	readonly urgency?: 'low' | 'normal' | 'high'
	readonly includeContext?: boolean
}

/**
 * What an advisor answered.
 *
 * Three more fields — a plan, a model suggestion, per-category tool guidance —
 * were declared here with neither a producer nor a reader, so they described
 * a shape the runtime never built and nothing ever branched on. The two that
 * remain are produced by the parser and consumed: decisions land in working
 * state and survive compaction, warnings are rendered back to the executing
 * agent.
 */
export interface AdvisoryResult {
	readonly advice: string
	/** Carried into working state, so they outlive the context they were given in. */
	readonly decisions?: string[]
	/** Rendered back to the executing agent under their own heading. */
	readonly warnings?: string[]
}

export interface AdvisoryCallRecord {
	readonly advisorId: string
	readonly triggerId?: string
	readonly request: AdvisoryRequest
	readonly result: AdvisoryResult
	readonly usage: TokenUsage
	readonly cost: CostInfo
	readonly durationMs: number
	readonly iteration: number
	readonly timestamp: number
}
