import type { AgentInput } from '../types/agent/base.js'
import type {
	CreateTaskOptions,
	SiblingFailurePolicy,
	TaskGateway,
	TaskHandle,
} from '../types/agent/gateway.js'
import type { AgentManagerContract } from '../types/agent/manager.js'
import type { AgentTaskContext } from '../types/agent/task.js'
import type { TaskId } from '../types/ids/index.js'
import { createUserMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/events.js'
import { toErrorMessage } from '../utils/error.js'
import { getRootLogger } from '../utils/logger.js'

export class LocalTaskGateway implements TaskGateway {
	private agentManager: AgentManagerContract
	private taskContext: AgentTaskContext
	private listener: RunEventListener | undefined
	private trackedTaskIds: Set<TaskId> = new Set()

	private parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides' | 'runtimeContext'>

	private completionListeners: Set<(handle: TaskHandle) => void> = new Set()

	private siblingFailurePolicy: SiblingFailurePolicy = 'continue'

	constructor(
		agentManager: AgentManagerContract,
		taskContext: AgentTaskContext,
		listener?: RunEventListener,
		parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides' | 'runtimeContext'>,
		options?: { siblingFailurePolicy?: SiblingFailurePolicy },
	) {
		this.agentManager = agentManager
		this.taskContext = taskContext
		this.listener = listener
		this.parentInput = parentInput
		if (options?.siblingFailurePolicy) {
			this.siblingFailurePolicy = options.siblingFailurePolicy
		}
	}

	async createTask(options: CreateTaskOptions): Promise<TaskHandle> {
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
			},
			// The budget tracker is SHARED on purpose and must not be cloned.
			// `AgentManager.spawn` debits it (`remaining -= allocatedTokens`)
			// so siblings divide one pool; handing each spawn a fresh copy
			// made the debit land on a throwaway object, so every child saw
			// the parent's untouched `remaining` and N children were each
			// allocated `maxBudgetFraction` of the SAME number — N x 50% of a
			// budget that only had 100% in it.
			this.taskContext,
			this.listener,
		)

		this.trackedTaskIds.add(task.taskId)

		this.agentManager
			.waitForCompletion(task.taskId)
			.then(() => {
				const completed = this.agentManager.getInstance(task.taskId)
				if (completed) {
					const handle = toHandle(completed)
					this.applySiblingPolicy(handle)
					for (const cb of this.completionListeners) {
						cb(handle)
					}
				}
			})
			.catch((err) => {
				getRootLogger()
					.child({ component: 'LocalTaskGateway' })
					.error('Task completion tracking failed', {
						taskId: task.taskId,
						error: toErrorMessage(err),
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
		if (!hasFailed(finished)) return

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
			getRootLogger()
				.child({ component: 'LocalTaskGateway' })
				.info('Cancelled siblings after a child failed', {
					failed: finished.taskId,
					agentId: finished.agentId,
					cancelled,
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

	listTasks(): TaskHandle[] {
		const handles: TaskHandle[] = []
		for (const taskId of this.trackedTaskIds) {
			const task = this.agentManager.getInstance(taskId)
			if (task) handles.push(toHandle(task))
		}
		return handles
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
function hasFailed(handle: TaskHandle): boolean {
	return handle.state === 'failed' || handle.result?.status === 'failed'
}

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
