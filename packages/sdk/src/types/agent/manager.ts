import type { SessionId, TaskId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { CancelCause } from '../session/cancel-cause.js'
import type { SessionEventListener } from '../session/events.js'
import type { AgentLifecycleListener } from './lifecycle-event.js'
import type { AgentTask, AgentTaskContext, AgentTaskState, SendMessageOptions } from './task.js'

/** Why a saved child could not be made continuable again. */
export type RestoreChildRefusal =
	/** No project layout is known, so there is no saved log to read. */
	| 'no-layout'
	/** Nothing readable is saved under that id for this parent. */
	| 'not-saved'
	/** The saved record belongs to another parent session. */
	| 'foreign'
	/** The saved record carries no continuation profile, was isolated, or names an agent the host cannot rebuild. */
	| 'not-resumable'
	/** The child never recorded an end: its process died mid-turn. */
	| 'unsettled'
	/** The child was cancelled. */
	| 'stopped'
	/** This manager already holds a continuation for it that is still running. */
	| 'running'
	/** Too many continuations are retained to take another. */
	| 'full'

export interface RestoreChildOptions {
	/** The saved child's session id. */
	readonly childSessionId: SessionId
	/** The directory the continued child works in; the same one it ran in. */
	readonly workingDirectory: string
	/**
	 * Which registered agent the child continues as, given the profile the host
	 * recorded at launch. Return `undefined` when the host cannot rebuild it.
	 */
	readonly agentFor: (profile: Readonly<Record<string, string>>) => string | undefined
}

export type RestoreChildResult =
	| {
			readonly status: 'restored'
			readonly childSessionId: SessionId
			/** The agent chosen by {@link RestoreChildOptions.agentFor}; pass it to `createTask` with `resumeSessionId`. */
			readonly agentId: string
			readonly profile: Readonly<Record<string, string>>
			readonly description: string
	  }
	| { readonly status: 'refused'; readonly reason: RestoreChildRefusal }

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

	/**
	 * Rebuild the right to continue a child that finished in an earlier process
	 * from its saved log and meta document, under the invoking parent's scope.
	 * Optional: only a manager that can read saved children offers it. Grants
	 * nothing by itself; continuing still goes through `sendMessage` with
	 * `resumeSessionId`, with the invoking turn's authority and limits.
	 */
	restoreChildConversation?(
		options: RestoreChildOptions,
		context: AgentTaskContext,
	): Promise<RestoreChildResult>

	cleanup(): void
	dispose(): void
}
