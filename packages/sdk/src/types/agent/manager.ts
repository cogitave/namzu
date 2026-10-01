import type { SessionId, TaskId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { CancelCause } from '../session/cancel-cause.js'
import type { SessionEventListener } from '../session/events.js'
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
		listener?: SessionEventListener,
	): Promise<AgentTask>

	cancel(taskId: TaskId, cause?: CancelCause): void
	/**
	 * Defaults to `'parent'` when a caller names nothing, because this call
	 * site IS a parent abandoning its children — unlike `AbstractAgent.cancel`,
	 * where the caller could be anyone.
	 */
	cancelAll(parentSessionId: SessionId, cause?: CancelCause): void

	/**
	 * Queue guidance for a nonterminal task. Acceptance is not delivery.
	 *
	 * The manager supplies `AgentConfig.inboundMessages`, which query-backed
	 * agents drain at provider-valid request boundaries, including completion.
	 * It does not interrupt an in-flight tool or model request. Custom agents
	 * must consume that callback; an agent that ignores it will not receive mail.
	 * Terminal tasks reject new input and cannot be restarted by this operation.
	 */
	continueTask(taskId: TaskId, message: string): Promise<void>
	/** Queue a structured message under the same acceptance contract. */
	queueMessage(taskId: TaskId, message: Message): void
	/** Destructive drain used by the manager's injected inbound callback. */
	drainMessages(taskId: TaskId): Message[]

	waitForCompletion(taskId: TaskId): Promise<void>
	getInstance(taskId: TaskId): AgentTask | undefined
	listByParent(parentSessionId: SessionId): AgentTask[]
	listActive(): AgentTask[]
	getState(taskId: TaskId): AgentTaskState | undefined

	on(listener: AgentLifecycleListener): void
	off(listener: AgentLifecycleListener): void

	cleanup(): void
	dispose(): void
}
