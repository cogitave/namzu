import type { AgentManager } from '../manager/agent/lifecycle.js'
import type { AgentInput } from '../types/agent/base.js'
import type { CreateTaskOptions, TaskGateway, TaskHandle } from '../types/agent/gateway.js'
import type { AgentTaskContext } from '../types/agent/task.js'
import type { TaskId } from '../types/ids/index.js'
import { createUserMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/events.js'

export class LocalTaskGateway implements TaskGateway {
	private agentManager: AgentManager
	private taskContext: AgentTaskContext
	private listener: RunEventListener | undefined
	private trackedTaskIds: Set<TaskId> = new Set()

	private parentInput?: Pick<AgentInput, 'taskStore' | 'runtimeToolOverrides'>

	private completionListeners: Set<(handle: TaskHandle) => void> = new Set()

	constructor(
		agentManager: AgentManager,
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
			.catch(() => {})

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
