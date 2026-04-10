export type TriggerType =
	| 'on_error'
	| 'on_iteration'
	| 'on_context_percent'
	| 'on_tool_category'
	| 'on_cost_percent'
	| 'on_complexity'
	| 'custom'

export type TriggerCondition =
	| { readonly type: 'on_error'; readonly categories?: string[] }
	| { readonly type: 'on_iteration'; readonly everyN: number }
	| { readonly type: 'on_context_percent'; readonly threshold: number }
	| { readonly type: 'on_tool_category'; readonly categories: string[] }
	| { readonly type: 'on_cost_percent'; readonly threshold: number }
	| { readonly type: 'on_complexity'; readonly toolCallThreshold: number }
	| { readonly type: 'custom'; readonly predicate: (state: TriggerEvaluationState) => boolean }

export interface TriggerEvaluationState {
	readonly iteration: number
	readonly totalToolCalls: number
	readonly totalTokens: number
	readonly contextWindowPercent: number
	readonly totalCostUsd: number
	readonly costBudgetPercent: number | undefined
	readonly lastError: string | undefined
	readonly lastToolCategory: string | undefined
	readonly advisoryCallCount: number
}

export interface AdvisoryTrigger {
	readonly id: string
	readonly condition: TriggerCondition
	readonly advisorId?: string
	readonly questionTemplate?: string
	readonly priority?: number
	readonly cooldownIterations?: number
	readonly enabled?: boolean
}
