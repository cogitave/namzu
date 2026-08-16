import type { ActorRef } from '../../types/session/actor.js'
import type { WorkspaceBackendKind } from '../../types/workspace/ref.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { RunId, SessionId, TaskId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { RunEventListener } from '../run/events.js'
import type { ProjectId, TopicId } from '../session/ids.js'
import type { AgentInput, BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'
import type { AgentFactoryOptions } from './factory.js'

export type AgentTaskState =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'canceled'
	| 'rejected'
	| 'input-required'

export function isTerminalAgentTaskState(state: AgentTaskState): boolean {
	return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
}

/**
 * Context carried into {@link AgentManager.sendMessage}. `tenantId`,
 * `topicId`, `sessionId`, `projectId`, and `parentActor` are required —
 * the spawn path is the ingress point for the session hierarchy; callers
 * must provide the full scoping set.
 */
export interface AgentTaskContext {
	parentRunId: RunId

	parentAgentId: string

	parentAbortController: AbortController

	depth: number

	budgetTracker: AgentTaskBudget

	factoryOptions?: AgentFactoryOptions

	/**
	 * The parent's channel to whoever can answer a decision it cannot make
	 * alone, handed down so a child asks the same person.
	 *
	 * Passed as the function itself, which works because delegation is
	 * in-process: `LocalTaskScheduler` is the only `TaskScheduler` in the tree.
	 * A gateway that dispatched across a process boundary could not carry a
	 * closure and would have to proxy the request onto the parent's event
	 * stream and route the answer back by request id — the upward half of
	 * which already exists, since `wrapChildListener` stamps lineage on
	 * every child event the parent sees.
	 *
	 * Absent means the child auto-approves, exactly as every child did
	 * before this existed.
	 */
	resumeHandler?: ResumeHandler

	/**
	 * The tool denies in force for the actor that owns this context — the
	 * union of every `toolScope.deny` recorded along its actor chain.
	 *
	 * Threaded, not re-derived from the chain, because `ActorRef` identifies
	 * an AGENT and not a spawn: two children of one parent running the same
	 * agent id have identical chains, so a lookup keyed on one could not
	 * tell their scopes apart.
	 *
	 * Absent means nothing was denied above here, which is what a top-level
	 * run has. It is only ever added to. A spawn's own denies union with
	 * this; nothing checks a spawn's denies AGAINST it, because a descendant
	 * narrowing further is the whole point and a descendant widening is what
	 * this exists to prevent.
	 */
	readonly toolDenies?: readonly string[]

	/** Isolation boundary. Required per session-hierarchy.md §12.1. */
	tenantId: TenantId

	/**
	 * Topic the current task belongs to. Required — spawn copies this onto
	 * the child session without a second TopicStore round-trip, and gates
	 * creation on {@link TopicManager.requireOpen}. Children inherit the
	 * parent's `topicId` verbatim; cross-topic spawn is forbidden by design
	 * (a delegated sub-agent stays on the same topic).
	 */
	topicId: TopicId

	/**
	 * Parent session under which any sub-agent spawn is recorded. Required
	 * in 0.2.0; a spawn cannot be attributed without it.
	 */
	sessionId: SessionId

	/**
	 * Long-lived goal scope. Required. Denormalized from the owning Thread
	 * (see {@link Thread}) — structurally immutable per Phase 2.4 decision
	 * (sessions never cross threads, threads never cross projects).
	 */
	projectId: ProjectId

	/**
	 * The actor invoking this task. Children built off this context stamp
	 * their own `parentActor: ActorRef` linking back via the actor chain
	 * (session-hierarchy.md §4.3 / §10.4).
	 */
	parentActor: ActorRef
}

export interface AgentTaskBudget {
	total: number

	remaining: number
}

export interface AgentTask {
	taskId: TaskId
	agentId: string
	agent: Agent<BaseAgentConfig, BaseAgentResult>
	childAbortController: AbortController
	context: AgentTaskContext
	state: AgentTaskState
	result?: BaseAgentResult

	/**
	 * Tokens reserved from the shared pool when this child was spawned.
	 *
	 * A RESERVATION, not a spend: it is subtracted up front so siblings
	 * cannot each be promised the same headroom, and the unused part is
	 * returned when the child settles. Without the return, a pool shrank
	 * by the full allocation every spawn regardless of what the child
	 * actually used, so a long session ran out of budget while almost none
	 * of it had been spent.
	 */
	budgetReservation?: number

	pendingMessages: Message[]
	createdAt: number
	completedAt?: number

	evictAfter?: number

	runEventListener?: RunEventListener
}

/**
 * Options accepted by {@link AgentManager.sendMessage}. Phase 6 adds the
 * required sub-session spawn scope (`parentSessionId`, `tenantId`, `projectId`,
 * `parentActor`) so the manager can create a SubSession + child Session +
 * WorkspaceRef triple atomically on every spawn.
 */
export interface SendMessageOptions {
	/** See {@link import('./scheduler.js').CreateTaskOptions.toolScope}. Deny-only. */
	readonly toolScope?: { readonly deny: readonly string[] }
	/** See {@link import('./scheduler.js').CreateTaskOptions.personaOverride}. */
	readonly personaOverride?: import('../persona/index.js').AgentPersona

	agentId: string

	input: AgentInput

	configOverrides?: Partial<BaseAgentConfig>

	budgetAllocation?: {
		tokenBudget?: number
		timeoutMs?: number
	}

	/**
	 * Parent session under which the new sub-session is created. Capacity
	 * validation (depth + width) is applied against this session.
	 */
	parentSessionId: SessionId

	tenantId: TenantId

	projectId: ProjectId

	/** The actor requesting the spawn — seeds the child's `parentActor`. */
	parentActor: ActorRef

	/**
	 * Workspace backend to provision for the child session. Defaults to
	 * `git-worktree` — the MVP reference backend from Phase 3.
	 */
	workspaceBackend?: WorkspaceBackendKind
}

export interface AgentManagerConfig {
	maxDepth: number

	evictionMs: number

	maxBudgetFraction: number

	/**
	 * Wall-clock deadline given to a spawned child when the caller supplies
	 * no `budgetAllocation.timeoutMs`.
	 *
	 * This exists because the fallback used to be
	 * `context.budgetTracker.remaining` — a TOKEN count read as
	 * milliseconds. The unit error hid for so long because a typical
	 * six-figure token budget lands in a plausible-looking range of
	 * milliseconds; it only bites at the edges, where an unlimited budget
	 * (`0`) became a zero-millisecond deadline and a small budget became a
	 * child that died in under a second.
	 */
	childTimeoutMs: number
}
