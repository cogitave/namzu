import type { CompactionConfig } from '../config/runtime.js'
import type { FileAction, FileSlot, PlanSlot, ToolResultSlot, WorkingState } from './types.js'

function createEmptyState(): WorkingState {
	return {
		task: '',
		plan: [],
		files: new Map<string, FileSlot>(),
		decisions: [],
		failures: [],
		discoveries: [],
		environment: [],
		toolResults: [],
		userRequirements: [],
		assistantNotes: [],
	}
}

export class WorkingStateManager {
	private state: WorkingState
	private readonly config: CompactionConfig

	constructor(config: CompactionConfig) {
		this.config = config
		this.state = createEmptyState()
	}

	setTask(task: string): void {
		this.state.task = task.slice(0, this.config.maxCharsPerTask)
	}

	setPlan(plan: PlanSlot[]): void {
		this.state.plan = plan
	}

	trackFile(path: string, action: FileAction): void {
		const existing = this.state.files.get(path)
		if (existing) {
			existing.actions.push(action)
		} else {
			this.state.files.set(path, { path, actions: [action] })
		}
	}

	addDecision(decision: string): void {
		this.pushWithEviction(this.state.decisions, decision, this.config.maxListSize)
	}

	addFailure(failure: string): void {
		this.pushWithEviction(this.state.failures, failure, this.config.maxListSize)
	}

	addDiscovery(discovery: string): void {
		this.pushWithEviction(this.state.discoveries, discovery, this.config.maxListSize)
	}

	addEnvironment(env: string): void {
		this.pushWithEviction(this.state.environment, env, this.config.maxListSize)
	}

	addToolResult(result: ToolResultSlot): void {
		this.state.toolResults.push(result)
		while (this.state.toolResults.length > this.config.maxToolResults) {
			this.state.toolResults.shift()
		}
	}

	addUserRequirement(requirement: string): void {
		const truncated = requirement.slice(0, this.config.maxCharsPerRequirement)
		this.pushWithEviction(this.state.userRequirements, truncated, this.config.maxListSize)
	}

	addAssistantNote(note: string): void {
		const truncated = note.slice(0, this.config.maxCharsPerNote)
		this.pushWithEviction(this.state.assistantNotes, truncated, this.config.maxListSize)
	}

	slotCount(): number {
		let count = 0
		if (this.state.task) count++
		count += this.state.plan.length
		count += this.state.files.size
		count += this.state.decisions.length
		count += this.state.failures.length
		count += this.state.discoveries.length
		count += this.state.environment.length
		count += this.state.toolResults.length
		count += this.state.userRequirements.length
		count += this.state.assistantNotes.length
		return count
	}

	getState(): WorkingState {
		return this.state
	}

	reset(): void {
		this.state = createEmptyState()
	}

	private pushWithEviction(list: string[], item: string, max: number): void {
		list.push(item)
		while (list.length > max) {
			list.shift()
		}
	}
}
