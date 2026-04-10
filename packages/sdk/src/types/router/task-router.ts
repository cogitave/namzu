export type TaskType =
	| 'compaction'
	| 'summarization'
	| 'exploration'
	| 'coding'
	| 'verification'
	| 'planning'
	| 'default'

export interface TaskRouterConfig {
	readonly compaction?: string | null
	readonly summarization?: string | null
	readonly exploration?: string | null
	readonly coding?: string | null
	readonly verification?: string | null
	readonly planning?: string | null
	readonly default?: string | null
}
