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

	/**
	 * Cancel a task. **Async, because a cancel has to reach the disk.**
	 *
	 * A child parked on a durable decision has no live process to signal — its generator
	 * returned when it parked — so a cancel that only aborts a signal leaves the decision
	 * `pending` on disk and the run `awaiting_input`, and a leaked resume token can still
	 * run its tools. Cancelling means transitioning the persisted record, and awaiting
	 * this is how a caller knows that it happened.
	 */
	cancel(taskId: TaskId): Promise<void>
	cancelAll(parentRunId: RunId): Promise<void>

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
