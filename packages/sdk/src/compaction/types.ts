export interface WorkingState {
	task: string
	plan: PlanSlot[]
	files: Map<string, FileSlot>
	decisions: string[]
	failures: string[]
	discoveries: string[]
	environment: string[]
	toolResults: ToolResultSlot[]
	userRequirements: string[]
	assistantNotes: string[]
	/**
	 * How many entries each capped list has dropped, keyed by slot name.
	 *
	 * The state that survives compaction is the only record of the history
	 * it replaced, so silently shrinking it is the one thing this structure
	 * must not do. Counting the loss lets the serializer say so, which is
	 * the difference between "here is the state" and "here is what is left
	 * of the state".
	 */
	evicted: Record<string, number>
}

export interface PlanSlot {
	id: string
	label: string
	status: 'pending' | 'active' | 'done' | 'skipped'
}

export interface FileSlot {
	path: string
	actions: FileAction[]
}

export type FileAction =
	| { type: 'read'; summary: string }
	| { type: 'edit'; detail: string }
	| { type: 'create'; detail: string }
	| { type: 'delete' }

export interface ToolResultSlot {
	tool: string
	summary: string
	timestamp: number
}

export type CompactionStrategy = 'structured' | 'salience' | 'sliding-window' | 'disabled'
