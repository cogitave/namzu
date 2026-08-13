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
		evicted: {},
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
		this.pushWithEviction('decisions', this.state.decisions, decision, this.config.maxListSize)
	}

	/**
	 * Failures evict OLDEST-first, unlike every other slot here.
	 *
	 * `keepFirstEntries` exists because early decisions are load-bearing —
	 * the one that set the run's approach outlives twenty-five incidental
	 * notes. That reasoning is right for decisions and backwards for
	 * failures: the earliest failure is the one the model has most likely
	 * already worked around, and the recent one is the thing it reads to
	 * decide what to do differently.
	 *
	 * It also matters more than a preference. Sinha et al.,
	 * "The Illusion of Diminishing Returns" (arXiv:2509.09677), inject
	 * errors into a model's own history at controlled rates and measure
	 * accuracy far later in the run: conditioning a model on its own
	 * error-prone history raises the likelihood of further errors, and
	 * scaling does not rescue it. So a permanently-protected early failure
	 * is not neutral ballast — it is the input that paper measures.
	 *
	 * Nothing here decided failures should keep their oldest entries; the
	 * behaviour was inherited from a shared helper written for a slot where
	 * it is correct.
	 */
	addFailure(failure: string): void {
		this.pushWithEviction('failures', this.state.failures, failure, this.config.maxListSize, 0)
	}

	addDiscovery(discovery: string): void {
		this.pushWithEviction('discoveries', this.state.discoveries, discovery, this.config.maxListSize)
	}

	addEnvironment(env: string): void {
		this.pushWithEviction('environment', this.state.environment, env, this.config.maxListSize)
	}

	addToolResult(result: ToolResultSlot): void {
		this.state.toolResults.push(result)
		// Tool results are the one slot where recency genuinely wins: an old
		// `read` of a file that has since been edited is worse than useless.
		// Oldest-first eviction is correct here; it is still counted.
		while (this.state.toolResults.length > this.config.maxToolResults) {
			this.state.toolResults.shift()
			this.state.evicted.toolResults = (this.state.evicted.toolResults ?? 0) + 1
		}
	}

	addUserRequirement(requirement: string): void {
		const truncated = requirement.slice(0, this.config.maxCharsPerRequirement)
		this.pushWithEviction(
			'userRequirements',
			this.state.userRequirements,
			truncated,
			this.config.maxListSize,
		)
	}

	addAssistantNote(note: string): void {
		const truncated = note.slice(0, this.config.maxCharsPerNote)
		this.pushWithEviction(
			'assistantNotes',
			this.state.assistantNotes,
			truncated,
			this.config.maxListSize,
		)
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

	/**
	 * Adopt a previously captured state.
	 *
	 * Used on resume: a run that compacted, checkpointed and came back in a
	 * new process needs the state its earlier summary was built from, or the
	 * next compaction supersedes that summary with one covering only what
	 * happened after the resume. See {@link restoreWorkingState}.
	 */
	replaceState(state: WorkingState): void {
		this.state = state
	}

	reset(): void {
		this.state = createEmptyState()
	}

	/**
	 * Append, evicting from the MIDDLE once the list is full.
	 *
	 * This used to `shift()`, dropping the oldest entry — so on a long run
	 * the 26th assistant note silently deleted the 1st, and "the structured
	 * state that survives compaction" degraded into a rolling window over
	 * recent activity. The early entries are the load-bearing ones: the
	 * original requirement, the decision that set the approach, the failure
	 * that ruled an option out. The recent ones are still in the
	 * un-compacted tail of the conversation.
	 *
	 * So the first `keepFirstEntries` are pinned and eviction happens just
	 * after them — `keep_first` semantics, the same shape OpenHands'
	 * condenser uses. The eviction is counted so the serializer can say
	 * something was dropped rather than presenting a gap as complete.
	 */
	private pushWithEviction(
		slot: string,
		list: string[],
		item: string,
		max: number,
		/**
		 * Entries to protect at the front. Defaults to the configured
		 * `keepFirstEntries`; pass 0 for a slot where the early entries are
		 * the ones to lose. See {@link addFailure}.
		 */
		keepFirstOverride?: number,
	): void {
		list.push(item)
		const keepFirst = Math.min(
			keepFirstOverride ?? this.config.keepFirstEntries,
			Math.max(0, max - 1),
		)
		while (list.length > max) {
			list.splice(keepFirst, 1)
			this.state.evicted[slot] = (this.state.evicted[slot] ?? 0) + 1
		}
	}
}
