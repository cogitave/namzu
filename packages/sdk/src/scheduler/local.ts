import { GENAI } from '../constants/telemetry/index.js'
import { taskFailed } from '../tools/coordinator/outcome.js'
import type { AgentInput } from '../types/agent/base.js'
import type { AgentManagerContract } from '../types/agent/manager.js'
import type {
	CreateTaskOptions,
	SiblingFailurePolicy,
	TaskHandle,
	TaskScheduler,
} from '../types/agent/scheduler.js'
import type { AgentTaskContext } from '../types/agent/task.js'
import type { TaskId } from '../types/ids/index.js'
import { createUserMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/events.js'
import { toErrorMessage } from '../utils/error.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

/**
 * How many launched tasks a gateway remembers.
 *
 * High enough that no realistic single run reaches it — a fan-out is eight,
 * a long supervisory run is dozens — so the listing a supervisor reads at the
 * end of its run is always complete. It exists for the host that reuses one
 * gateway across runs, where the alternative is a set and a map that grow for
 * the life of the process.
 */
const GATEWAY_TASK_LEDGER_CAP = 1_000

export class LocalTaskScheduler implements TaskScheduler {
	private agentManager: AgentManagerContract
	private taskContext: AgentTaskContext
	private listener: RunEventListener | undefined
	private trackedTaskIds: Set<TaskId> = new Set()

	private parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides' | 'runtimeContext'>

	private completionListeners: Set<(handle: TaskHandle) => void> = new Set()

	/**
	 * The settled summary of each task, kept past the manager's eviction.
	 *
	 * Terminal tasks leave the manager 30 seconds after they finish, and
	 * `listTasks` rebuilt itself by looking every tracked id back up — so a
	 * task that finished a minute ago simply vanished from the tool whose
	 * whole job is the end-of-run check. A supervisor could not tell an
	 * evicted task from one that never launched; both read as absence.
	 *
	 * Eviction is there to release the heavy state — messages, controllers,
	 * spawn records — not the fact that the task ran. This is a handful of
	 * fields per task, bounded by the number the gateway itself launched.
	 */
	private settledHandles: Map<TaskId, TaskHandle> = new Map()

	private siblingFailurePolicy: SiblingFailurePolicy = 'continue'
	/** See {@link onTaskProgress}. */
	private readonly progressListeners = new Set<(taskId: TaskId) => void>()
	/** Raw, unresolved — kept as the caller handed it so each of the two log
	 * sites below resolves it independently via `resolveLogger`, rather than
	 * this constructor baking in ONE `.child()` binding both would then share
	 * (which would also change how many `component:` bindings this file has,
	 * a different ratchet than the one this task moves). */
	private readonly log?: Logger

	constructor(
		agentManager: AgentManagerContract,
		taskContext: AgentTaskContext,
		listener?: RunEventListener,
		parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides' | 'runtimeContext'>,
		options?: { siblingFailurePolicy?: SiblingFailurePolicy; log?: Logger },
	) {
		this.agentManager = agentManager
		this.taskContext = taskContext
		this.listener = listener
		this.parentInput = parentInput
		this.log = options?.log
		if (options?.siblingFailurePolicy) {
			this.siblingFailurePolicy = options.siblingFailurePolicy
		}
	}

	async createTask(options: CreateTaskOptions): Promise<TaskHandle> {
		// Filled once the spawn resolves. A box rather than a bare binding
		// because the assignment happens AFTER the `await` that the reader is
		// passed into — see the progress tee below for why it cannot simply
		// read the `task` const it is declared beside.
		const launched: { id?: TaskId } = {}

		const task = await this.agentManager.sendMessage(
			{
				agentId: options.agentId,
				input: {
					messages: [createUserMessage(options.prompt)],
					workingDirectory: options.workingDirectory,
					taskStore: this.parentInput?.taskStore,
					runtimeToolOverrides: this.parentInput?.runtimeToolOverrides,
					runtimeContext: options.runtimeContext ?? this.parentInput?.runtimeContext,
				},
				// Phase 6: spawn scope propagates from the gateway's task context.
				// The caller built it at SupervisorAgent boundary (§12.1).
				parentSessionId: this.taskContext.sessionId,
				tenantId: this.taskContext.tenantId,
				projectId: this.taskContext.projectId,
				parentActor: this.taskContext.parentActor,
				// The caller's overrides, plus the span the caller supplied so a
				// delegated run joins the trace it belongs to instead of
				// starting its own root.
				//
				// `options.configOverrides` used to be dropped here: this built
				// a fresh object from `parentSpan` and never looked at the
				// field, so a caller pinning a child to a cheaper model got the
				// agent's default and no sign anything had been ignored. The
				// dedicated `parentSpan` option is applied last because it is
				// the specific field for that job — a caller who sets both is
				// saying the same thing twice, and the named one is the answer.
				...(options.configOverrides || options.parentSpan
					? {
							configOverrides: {
								...options.configOverrides,
								...(options.parentSpan ? { parentSpan: options.parentSpan } : {}),
							},
						}
					: {}),
			},
			// The budget tracker is SHARED on purpose and must not be cloned.
			// `AgentManager.spawn` debits it (`remaining -= allocatedTokens`)
			// so siblings divide one pool; handing each spawn a fresh copy
			// made the debit land on a throwaway object, so every child saw
			// the parent's untouched `remaining` and N children were each
			// allocated `maxBudgetFraction` of the SAME number — N x 50% of a
			// budget that only had 100% in it.
			this.taskContext,
			// The host's listener still sees everything it always did; this
			// only tees off the fact that SOMETHING happened, which is what an
			// idle bound measures. The event itself is not forwarded — a
			// progress signal that carried the child's output would be a
			// second, undocumented way to read a worker's work.
			//
			// The id comes from `launched.id`, NOT from the `task` const
			// below. This callback is handed to the very `await` that assigns
			// `task`, so a child that emits anything before `sendMessage`
			// resolves reached it inside the temporal dead zone and threw
			// `Cannot access 'task' before initialization` — killing the launch
			// outright.
			//
			// It survived because a single sequential launch usually resolves
			// before the child says anything. A concurrent fan-out does not:
			// with four `create_task` calls from one turn — the shape this
			// tool's own description tells the model to use — the event loop
			// interleaves and three of the four died. Found by running one.
			(event) => {
				this.listener?.(event)
				// No id yet means nothing is waiting on this task: the caller
				// does not hold the handle, so an idle bound cannot be running
				// against it. There is no progress to report to anyone.
				if (launched.id === undefined) return
				for (const notify of this.progressListeners) notify(launched.id)
			},
		)

		launched.id = task.taskId
		this.trackedTaskIds.add(task.taskId)
		this.forgetOldestBeyondCap()

		this.agentManager
			.waitForCompletion(task.taskId)
			.then(() => {
				const completed = this.agentManager.getInstance(task.taskId)
				if (completed) {
					const handle = toHandle(completed)
					// Snapshot now, while the manager still holds it — in 30
					// seconds eviction takes the record away.
					this.settledHandles.set(task.taskId, handle)
					this.applySiblingPolicy(handle)
					for (const cb of this.completionListeners) {
						cb(handle)
					}
				}
			})
			.catch((err) => {
				resolveLogger(this.log)
					.child({ component: 'LocalTaskScheduler' })
					.error('Task completion tracking failed', {
						'namzu.task.id': task.taskId,
						'exception.message': toErrorMessage(err),
					})
			})

		return toHandle(task)
	}

	/**
	 * Decide what a failed child means for the ones still running.
	 *
	 * The primitive to stop them already existed — every child holds an
	 * abort controller chained to the parent's, and `AgentManager.cancel`
	 * uses it — but nothing connected a failure to it. So a supervisor that
	 * fanned out five tasks and watched one die had no way to say the other
	 * four were now pointless: they ran to completion spending budget on
	 * work whose premise had gone.
	 *
	 * `'continue'` stays the default, and deliberately. Partial results are
	 * usually worth having, and a policy that tore down healthy siblings on
	 * any failure would make one flaky child able to waste four good ones.
	 * The point is that the choice is now expressible, not that the answer
	 * changed.
	 */
	private applySiblingPolicy(finished: TaskHandle): void {
		if (this.siblingFailurePolicy !== 'cancel-siblings') return
		if (!taskFailed(finished)) return

		const cancelled: TaskId[] = []
		for (const taskId of this.trackedTaskIds) {
			if (taskId === finished.taskId) continue
			const sibling = this.agentManager.getInstance(taskId)
			// `cancel` is already a no-op on a terminal task, but checking
			// here keeps the log honest about what was actually stopped.
			if (!sibling || sibling.state === 'completed' || sibling.state === 'failed') continue
			this.agentManager.cancel(taskId)
			cancelled.push(taskId)
		}

		if (cancelled.length > 0) {
			resolveLogger(this.log)
				.child({ component: 'LocalTaskScheduler' })
				.info('Cancelled siblings after a child failed', {
					'namzu.scheduler.failed': finished.taskId,
					[GENAI.AGENT_ID]: finished.agentId,
					'namzu.scheduler.cancelled': cancelled,
				})
		}
	}

	async waitForTask(taskId: TaskId): Promise<TaskHandle> {
		await this.agentManager.waitForCompletion(taskId)
		const task = this.agentManager.getInstance(taskId)
		if (!task) {
			throw new Error(`Task ${taskId} not found after completion`)
		}
		return toHandle(task)
	}

	async continueTask(taskId: TaskId, message: string): Promise<void> {
		await this.agentManager.continueTask(taskId, message)
	}

	cancelTask(taskId: TaskId): void {
		this.agentManager.cancel(taskId)
	}

	getTask(taskId: TaskId): TaskHandle | undefined {
		const task = this.agentManager.getInstance(taskId)
		return task ? toHandle(task) : undefined
	}

	/**
	 * Snapshots a task's terminal state so it survives eviction.
	 *
	 * Called when the task settles, while the manager still holds it.
	 */
	rememberSettled(taskId: TaskId): void {
		const task = this.agentManager.getInstance(taskId)
		if (task) this.settledHandles.set(taskId, toHandle(task))
	}

	/**
	 * Drop the oldest tasks once the ledger passes {@link GATEWAY_TASK_LEDGER_CAP}.
	 *
	 * A gateway constructed per run is bounded by that run and this never
	 * fires. But `SupervisorAgentConfig.gateway` lets a host supply its own,
	 * and a long-lived host reusing one accumulates an id and a settled handle
	 * per task it ever launched, for the life of the process — the doc above
	 * says "bounded by the number the gateway itself launched", which is true
	 * and is not a bound when the gateway outlives the run.
	 *
	 * Both collections are evicted **together and in insertion order**. Losing
	 * a tracked id while keeping its handle, or the reverse, would make a task
	 * that ran read as one that never launched — which is the exact defect the
	 * settled-handle map was added to fix, reintroduced by its own cleanup.
	 */
	private forgetOldestBeyondCap(): void {
		while (this.trackedTaskIds.size > GATEWAY_TASK_LEDGER_CAP) {
			const oldest = this.trackedTaskIds.values().next().value
			if (oldest === undefined) return
			this.trackedTaskIds.delete(oldest)
			this.settledHandles.delete(oldest)
		}
	}

	listTasks(): TaskHandle[] {
		const handles: TaskHandle[] = []
		for (const taskId of this.trackedTaskIds) {
			// The live task wins: a remembered snapshot must never shadow
			// state that is still being updated.
			const task = this.agentManager.getInstance(taskId)
			if (task) {
				handles.push(toHandle(task))
				continue
			}
			const settled = this.settledHandles.get(taskId)
			if (settled) handles.push(settled)
		}
		return handles
	}

	/**
	 * Every event a child emits, reduced to "this one is still alive".
	 *
	 * Deliberately just the id. A caller that wanted the event itself has
	 * the run listener; what an idle clock needs is the fact, and passing
	 * the payload here would make this a second way to read a worker's
	 * output — one nobody documented and nothing frames as untrusted.
	 */
	onTaskProgress(callback: (taskId: TaskId) => void): () => void {
		this.progressListeners.add(callback)
		return () => {
			this.progressListeners.delete(callback)
		}
	}

	onTaskCompleted(callback: (handle: TaskHandle) => void): () => void {
		this.completionListeners.add(callback)
		return () => {
			this.completionListeners.delete(callback)
		}
	}
}

/**
 * Did this child fail?
 *
 * Two answers have to agree. `state` is `'failed'` only when the spawn
 * machinery itself threw; a child whose agent RAN and returned
 * `status: 'failed'` lands in `markCompleted` regardless, carrying the
 * failure in its result rather than its state. Reading only the state
 * would therefore miss the ordinary case — an agent that tried and could
 * not — and catch only the exceptional one.
 */
function toHandle(task: import('../types/agent/task.js').AgentTask): TaskHandle {
	return {
		taskId: task.taskId,
		agentId: task.agentId,
		state: task.state,
		result: task.result,
		createdAt: task.createdAt,
		completedAt: task.completedAt,
	}
}
