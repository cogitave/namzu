import type { TaskId } from '../ids/index.js'
import type { BaseAgentResult } from './base.js'
import type { AgentTaskState } from './task.js'

export interface TaskHandle {
	readonly taskId: TaskId
	readonly agentId: string
	readonly state: AgentTaskState
	readonly result?: BaseAgentResult
	readonly createdAt: number
	readonly completedAt?: number
}

export interface CreateTaskOptions {
	agentId: string

	prompt: string

	workingDirectory: string

	configOverrides?: Record<string, unknown>
}

export interface TaskGateway {
	createTask(options: CreateTaskOptions): Promise<TaskHandle>

	waitForTask(taskId: TaskId): Promise<TaskHandle>

	continueTask(taskId: TaskId, message: string): Promise<void>

	cancelTask(taskId: TaskId): void

	getTask(taskId: TaskId): TaskHandle | undefined

	listTasks(): TaskHandle[]

	onTaskCompleted(callback: (handle: TaskHandle) => void): () => void
}
