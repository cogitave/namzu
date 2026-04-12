import type { RunId, TaskId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { RunEventListener } from '../run/events.js'
import type { AgentLifecycleListener } from './lifecycle-event.js'
import type { AgentTask, AgentTaskContext, AgentTaskState, SendMessageOptions } from './task.js'

/**
 * Agent task lifecycle contract — task creation, cancellation, messaging, and completion tracking.
 * Concrete implementation: `AgentManager` in `manager/agent/lifecycle.ts`.
 */
export interface AgentManagerContract {
	sendMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask>

	cancel(taskId: TaskId): void
	cancelAll(parentRunId: RunId): void

	continueTask(taskId: TaskId, message: string): Promise<void>
	queueMessage(taskId: TaskId, message: Message): void
	drainMessages(taskId: TaskId): Message[]

	waitForCompletion(taskId: TaskId): Promise<void>
	getInstance(taskId: TaskId): AgentTask | undefined
	listByParent(parentRunId: RunId): AgentTask[]
	listActive(): AgentTask[]
	getState(taskId: TaskId): AgentTaskState | undefined

	on(listener: AgentLifecycleListener): void
	off(listener: AgentLifecycleListener): void

	cleanup(): void
	dispose(): void
}
