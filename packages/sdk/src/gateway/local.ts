import type { AgentInput } from '../types/agent/base.js'
import type { CreateTaskOptions, TaskGateway, TaskHandle } from '../types/agent/gateway.js'
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

	private parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides'>

	private completionListeners: Set<(handle: TaskHandle) => void> = new Set()

	constructor(
		agentManager: AgentManagerContract,
		taskContext: AgentTaskContext,
		listener?: RunEventListener,
		parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides'>,
	) {
		this.agentManager = agentManager
		this.taskContext = taskContext
		this.listener = listener
		this.parentInput = parentInput
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
				},
				// Phase 6: spawn scope propagates from the gateway's task context.
				// The caller built it at SupervisorAgent boundary (§12.1).
				parentSessionId: this.taskContext.sessionId,
				tenantId: this.taskContext.tenantId,
				projectId: this.taskContext.projectId,
				parentActor: this.taskContext.parentActor,
			},
			{ ...this.taskContext, budgetTracker: { ...this.taskContext.budgetTracker } },
			this.listener,
		)

		this.trackedTaskIds.add(task.taskId)

		this.agentManager
			.waitForCompletion(task.taskId)
			.then(() => {
				const completed = this.agentManager.getInstance(task.taskId)
				if (completed) {
					const handle = toHandle(completed)
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

	/**
	 * `TaskGateway.cancelTask` is fire-and-forget by contract, and the durable half of a
	 * cancel is not. The signal fires and the task is terminalized synchronously inside
	 * `cancel()`; the write that closes a parked child's decision is dispatched here and
	 * its failure is logged rather than swallowed. A caller that must know the decision is
	 * closed goes to `AgentManager.cancel` and awaits it.
	 */
	cancelTask(taskId: TaskId): void {
		this.agentManager.cancel(taskId).catch((err) => {
			getRootLogger().error('Durable cancel failed for task', {
				taskId,
				error: err instanceof Error ? err.message : String(err),
			})
		})
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
