import type { TaskId } from '../ids/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { AgentRuntimeContext, BaseAgentConfig, BaseAgentResult } from './base.js'
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
	/**
	 * Span the spawned run should hang off — normally the executing tool's
	 * own span, so the delegation shows up inside the turn that asked for
	 * it rather than as a disconnected root trace.
	 */
	readonly parentSpan?: import('@opentelemetry/api').Span

	agentId: string

	/**
	 * Tools this ONE delegation may not use, on top of whatever the child
	 * would otherwise have.
	 *
	 * Deny-only, and the shape is the point: a per-call scope that could
	 * ADD a tool is a privilege-escalation surface wearing the word
	 * "scope". Widening has to be unexpressible, not merely discouraged —
	 * a caller who wants a child to have more tools changes the agent's
	 * definition, where somebody can see it.
	 *
	 * Naming a tool the child never had is a no-op, not an error: the
	 * result is still narrower, and refusing would make a caller's deny
	 * list depend on which agent it happened to be talking to.
	 */
	readonly toolScope?: { readonly deny: readonly string[] }

	/**
	 * Replace the child's assembled persona for this delegation only.
	 *
	 * Scoped to the call rather than the agent, so a supervisor can hand
	 * one subtask a narrower brief without redefining an agent every other
	 * delegation shares.
	 */
	readonly personaOverride?: AgentPersona

	prompt: string

	workingDirectory: string

	runtimeContext?: AgentRuntimeContext

	/**
	 * Config the spawned run should be built with, overriding what the
	 * agent's own definition supplies — the model it runs on, its iteration
	 * ceiling, its thinking or effort settings.
	 *
	 * **This was accepted and dropped.** `LocalTaskScheduler.createTask` built
	 * its own `configOverrides` object out of `parentSpan` alone and never
	 * read this field, so a caller pinning a delegated run to a cheaper model
	 * got the agent's default model and no indication otherwise. It is
	 * forwarded now, with the dedicated {@link parentSpan} option winning if
	 * both name a span, since that one is the specific field for the job.
	 *
	 * Typed as `Partial<BaseAgentConfig>` rather than
	 * `Record<string, unknown>`: this lands on `SendMessageOptions`, which is
	 * already that shape, and the loose type let a misspelled key type-check
	 * and then do nothing — the same silence this field was already producing.
	 */
	configOverrides?: Partial<BaseAgentConfig>
}

export interface TaskScheduler {
	createTask(options: CreateTaskOptions): Promise<TaskHandle>

	waitForTask(taskId: TaskId): Promise<TaskHandle>

	continueTask(taskId: TaskId, message: string): Promise<void>

	cancelTask(taskId: TaskId): void

	/**
	 * The task's current state, or `undefined` if this gateway does not know
	 * about it.
	 *
	 * **A task that has just settled should still be findable here.** The
	 * kernel uses this to recover one specific race: `createTask` resolves a
	 * microtask before its caller can record whose the task is, so a worker
	 * that finishes inside that window is announced to a listener that cannot
	 * yet place it. `CompletionInbox` buffers the announcement AND asks this
	 * method, and the second is what covers the case the buffer could not
	 * hold.
	 *
	 * This is a request, not a requirement, and the cost of not meeting it is
	 * yours: a gateway that forgets a task the instant it completes still
	 * works, but under a burst large enough to overflow the buffer a fast
	 * worker's result can go unannounced. `LocalTaskScheduler` meets it for as
	 * long as the manager holds the record.
	 */
	getTask(taskId: TaskId): TaskHandle | undefined

	listTasks(): TaskHandle[]

	onTaskCompleted(callback: (handle: TaskHandle) => void): () => void

	/**
	 * Tell me when a task does something, not just when it finishes.
	 *
	 * This is what an idle bound is measured against. A wall clock says
	 * nothing about whether a worker is working: an hour is long enough to
	 * be useless as a stall detector, and short enough to kill a child that
	 * is making steady progress at minute fifty-nine. Time-without-progress
	 * is the quantity that separates "stuck" from "slow", and only the
	 * gateway can see it.
	 *
	 * OPTIONAL, and the absence is meaningful rather than an oversight: a
	 * gateway that cannot observe its children still works, and its waits
	 * are bounded by the wall clock alone — which is exactly the behaviour
	 * before this existed. It is optional because `TaskScheduler` is
	 * implemented by hosts, and a required method would break every one of
	 * them for a capability not all of them can provide.
	 *
	 * Anything the worker did counts: a tool call, an emitted token, a state
	 * change. What must NOT count is the supervisor's own activity — the
	 * point is to notice a child that has gone quiet, and a parent polling
	 * about it is not the child speaking.
	 */
	onTaskProgress?(callback: (taskId: TaskId) => void): () => void
}
