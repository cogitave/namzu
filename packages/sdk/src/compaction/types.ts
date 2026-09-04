export interface WorkingState {
	task: string
	plan: PlanSlot[]
	/**
	 * Facts pinned by tools, by key. A tool that knows something the model
	 * must not lose — what its controls do, where the piece is, what has
	 * already failed — pins it with a key, and a later pin under the same
	 * key replaces it. Pins live in the working-memory slot, so they are in
	 * front of the model every iteration and survive compaction; the
	 * rule-based extractor below only guesses, a pin is stated.
	 */
	pins: Map<string, PinSlot>
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

export interface PinSlot {
	key: string
	text: string
	/** The tool that pinned it. */
	source: string
	updatedAt: number
}

/** What a tool result carries to pin a fact; see `ToolResult.workingState`. */
export interface WorkingStatePin {
	readonly key: string
	readonly text: string
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
