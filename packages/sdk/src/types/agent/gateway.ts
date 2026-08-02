import type { TaskId } from '../ids/index.js'
import type { AgentRuntimeContext, BaseAgentResult } from './base.js'
import type { AgentTaskState } from './task.js'

export interface TaskHandle {
	readonly taskId: TaskId
	readonly agentId: string
	readonly state: AgentTaskState
	readonly result?: BaseAgentResult
	readonly createdAt: number
	readonly completedAt?: number
}

/**
 * What a failed child means for the siblings still running.
 *
 * `'continue'` — the default, and deliberately so. Partial results are
 * usually worth having, and tearing down healthy siblings on any failure
 * would let one flaky child waste four good ones.
 *
 * `'cancel-siblings'` — stop the rest. For a fan-out whose parts only mean
 * something together: if one leg of a comparison dies, the others are
 * spending budget on an answer nobody can use.
 */
export type SiblingFailurePolicy = 'continue' | 'cancel-siblings'

export interface CreateTaskOptions {
	agentId: string

	prompt: string

	workingDirectory: string

	runtimeContext?: AgentRuntimeContext

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
