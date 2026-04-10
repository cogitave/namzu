import type { CostInfo, TokenUsage } from '../common/index.js'

export interface AdvisoryRequest {
	readonly advisorId?: string
	readonly question: string
	readonly domain?: string
	readonly urgency?: 'low' | 'normal' | 'high'
	readonly includeContext?: boolean
}

export interface AdvisoryResult {
	readonly advice: string
	readonly plan?: Array<{ step: string; status?: string }>
	readonly decisions?: string[]
	readonly warnings?: string[]
	readonly modelSuggestion?: string
	readonly toolGuidance?: Array<{
		readonly category: string
		readonly recommendation: 'prefer' | 'avoid' | 'required'
		readonly reason?: string
	}>
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
