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

export type CompactionStrategy = 'structured' | 'sliding-window' | 'disabled'
