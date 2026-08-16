import type { RunId, TaskId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { CancelCause } from '../run/cancel-cause.js'
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
	/**
	 * Defaults to `'parent'` when a caller names nothing, because this call
	 * site IS a parent abandoning its children — unlike `AbstractAgent.cancel`,
	 * where the caller could be anyone.
	 */
	cancelAll(parentRunId: RunId, cause?: CancelCause): void

	/**
	 * Queue a message for a running task.
	 *
	 * **The runtime does not deliver it.** These three methods maintain a
	 * per-task queue that nothing in the iteration loop reads: the consumer
	 * that once drained it was removed, and the mid-run delivery handshake
	 * that would replace it is a host concern, not a kernel one. A caller
	 * who assumes `continueTask` reaches the agent is queuing into a buffer
	 * only {@link drainMessages} empties.
	 *
	 * Kept, and documented rather than deleted, because `drainMessages` is
	 * the only way a host can pick these up at all — removing it would take
	 * away the escape hatch and leave the trap.
	 *
	 * **For mid-run guidance, use `SteeringChannel` instead.** That is the
	 * delivery handshake this queue was missing: text queued on it is
	 * appended to the running batch's last `tool_result`, which is the only
	 * slot a provider accepts mid-batch, and the loop drains it. Pass one as
	 * `steering` on `drainQuery` params or on `SupervisorAgentConfig`.
	 *
	 * Two other routes also work: reject/modify feedback rides inside a tool
	 * result, and `prepareStep`'s `system` string is appended to the next
	 * model call from a hook that sees live history.
	 */
	continueTask(taskId: TaskId, message: string): Promise<void>
	/** See {@link continueTask} — queued, not delivered. */
	queueMessage(taskId: TaskId, message: Message): void
	/** Empty the queue {@link continueTask} fills. The host must call this. */
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
