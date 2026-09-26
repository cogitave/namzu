import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import type { WorkspaceBackendKind, WorkspaceRef } from '../../types/workspace/ref.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { SessionId, TaskId, TenantId, TurnId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { SessionEventListener } from '../session/events.js'
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

/** Per-spawn filesystem choice. Omission preserves the manager's existing behavior. */
export type ChildWorkspaceRequest =
	| { readonly mode: 'shared' }
	| {
			readonly mode: 'isolated'
			readonly backend: 'git-worktree'
			readonly baseRef?: string
			/** Relative directory within the checkout where this child starts. */
			readonly subdirectory?: string
			/** The existing SDK behavior is `dispose`; CLI delegates select `retain`. */
			readonly retention?: 'dispose' | 'retain'
	  }

export function isTerminalAgentTaskState(state: AgentTaskState): boolean {
	return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
}

/**
 * Where a child session keeps its state, as its parent chose it.
 *
 * `memory`: the parent's session log is in memory and it named no
 * `SessionPaths`, so the child session runs in memory too.
 * {@link AgentManager.sendMessage} gives the child a fresh
 * `InMemorySessionLog` and, when the parent named one, the parent's
 * `checkpointStore`, so the child writes nothing under `NAMZU_HOME`.
 *
 * `disk`: the parent's session is on disk in the layout `paths` (the one it
 * named, or the default for its working directory under `NAMZU_HOME`). The
 * child's log goes at `<parent-session-dir>/subagents/<child-id>.jsonl`
 * beside its `<child-id>.meta.json`, nested under every ancestor.
 *
 * A child config that already names a `sessionLog` or `paths` keeps what it
 * names.
 */
export type ChildSessionStorage =
	| {
			readonly kind: 'memory'
			readonly checkpointStore?: import('../../store/checkpoint/index.js').SessionCheckpointStore
	  }
	| {
			readonly kind: 'disk'
			readonly paths: import('../../session/paths.js').SessionPaths
	  }

/**
 * Context carried into {@link AgentManager.sendMessage}. `tenantId`,
 * `topicId`, `sessionId`, `projectId`, and `parentActor` are required —
 * the spawn path is the ingress point for the session hierarchy; callers
 * must provide the full scoping set.
 */
export interface AgentTaskContext {
	/** The session that is delegating. */
	parentSessionId: SessionId

	/** The parent turn whose tool call is spawning the child. */
	parentTurnId: TurnId

	parentAgentId: string

	parentAbortController: AbortController

	depth: number

	/** Shared authority for this parent and every delegated descendant. */
	budget: SessionTokenBudget

	factoryOptions?: AgentFactoryOptions

	/**
	 * The parent's channel to whoever reviews decisions it cannot make alone,
	 * handed down so a child's REVIEW-tier tool calls reach the same person.
	 * This does not grant a delegated agent the `ask_user_question` tool:
	 * interactive questions are a root-agent capability, while authorization
	 * review must remain inherited to avoid unattended auto-approval below the
	 * root.
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
	 * The tool-result screens in force for the parent session, handed down so a
	 * delegated child screens its results the same way.
	 *
	 * A child is a fresh turn with its own executor, so without this it
	 * installs `DEFAULT_TOOL_RESULT_GUARDRAILS` whatever the parent decided —
	 * and a host that turned the screens off with `[]` (or substituted a
	 * `passthroughTools` exemption for a tool it knows) would find the
	 * default back on in exactly the half a delegation is made of. Same
	 * shape as `resumeHandler` above and for the same reason: the child's
	 * `configBuilder` is written by whoever registered the agent and cannot
	 * be expected to forward a field it was never told about, so the manager
	 * stamps this onto the child config after the builder runs.
	 *
	 * Absent means the parent stated no policy of its own, and the child
	 * installs the shipped default — which is what every turn does when its
	 * host configured nothing.
	 */
	toolResultGuardrails?: readonly import('../guardrail/index.js').ToolResultGuardrailSpec[]

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

	/**
	 * Where the parent keeps its turn state, handed to every child it
	 * delegates to. See {@link ChildSessionStorage}. `SupervisorAgent` sets it
	 * from its own `sessionLog` and `paths`; a host that builds its own
	 * context for a `LocalTaskScheduler` beside an in-memory `query()` sets it
	 * the same way. Absent: children resolve their storage from their own
	 * config, as before.
	 */
	readonly childStorage?: ChildSessionStorage

	/**
	 * The parent's `reviewAllowedCalls`, handed to every child it delegates
	 * to and on to theirs. See `BaseAgentConfig.reviewAllowedCalls`.
	 *
	 * The function itself, not a sampled value, so a stricter mode entered
	 * while a child runs reaches that child's next batch. `AgentManager`
	 * stamps it onto the child config after the builder runs and carries it
	 * on the child's own context; a child config that sets its own keeps it,
	 * and the two are OR-ed, so a descendant can add review and never shed
	 * it. `SupervisorAgent` sets it from its config; a host that builds its
	 * own context for a `TaskScheduler` sets it from the same function it
	 * passes its own `query()`. Absent: children decide from their own config.
	 */
	readonly reviewAllowedCalls?: () => boolean

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

/** Budget authority shared by an agent task and its descendants. */
export type AgentTaskBudget = SessionTokenBudget

export interface AgentTask {
	taskId: TaskId
	agentId: string
	agent: Agent<BaseAgentConfig, BaseAgentResult>
	childAbortController: AbortController
	/** While pending admission this is the submitting authority; admitted tasks receive child scope. */
	context: AgentTaskContext
	state: AgentTaskState
	result?: BaseAgentResult

	pendingMessages: Message[]
	createdAt: number
	completedAt?: number
	/** Populated after an explicitly isolated spawn is admitted. */
	workspace?: WorkspaceRef

	evictAfter?: number

	sessionEventListener?: SessionEventListener
}

/**
 * Options accepted by {@link AgentManager.sendMessage}. Phase 6 adds the
 * required sub-session spawn scope (`parentSessionId`, `tenantId`, `projectId`,
 * `parentActor`) so the manager can create a SubSession + child Session +
 * WorkspaceRef triple atomically on every spawn.
 */
export interface SendMessageOptions {
	/** Explicit child filesystem policy; omitted preserves legacy backend behavior. */
	readonly workspace?: ChildWorkspaceRequest
	/**
	 * Revalidate host authority before admission, including after a capacity wait.
	 * Queue retries may invoke this more than once; checks must tolerate repeated calls.
	 */
	readonly beforeStart?: () => Promise<void>

	/** See {@link import('./scheduler.js').CreateTaskOptions.toolScope}. Deny-only. */
	readonly toolScope?: { readonly deny: readonly string[] }
	/** See {@link import('./scheduler.js').CreateTaskOptions.personaOverride}. */
	readonly personaOverride?: import('../persona/index.js').AgentPersona

	/** Approved plan edge inherited from the delegation tool, when present. */
	readonly planId?: string
	readonly planStepId?: string

	/**
	 * Display grouping for the delegated child, carried onto its
	 * `agent_pending` event so a consumer watching from outside this process
	 * can group the child the way this caller meant. Reach, not durability:
	 * that event goes straight to a host's listener and enters no session log,
	 * so nothing here is persisted by the kernel. See the `agent_pending`
	 * variant in `types/session/events.ts` for the full contract.
	 *
	 * These fields are display annotations only; they do not create
	 * dependencies, barriers, or serial execution. The kernel reads none of
	 * them — a caller wanting correlation a host may act on has
	 * {@link planId} and {@link planStepId} for that.
	 */
	readonly workflow?: string
	/** Stage within {@link workflow}. Display-only on the same terms. */
	readonly phase?: string
	/** Longer text explaining {@link phase}. Display-only on the same terms. */
	readonly phaseDetail?: string
	/** Zero-based DISPLAY order for {@link phase}. Display-only on the same terms. */
	readonly phaseOrder?: number

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
	/** When neither task workspace field is set, use the registered backend (legacy) or share cwd. */
	workspaceDefault?: 'registered' | 'shared'

	/** Reject a full parent immediately (default), or retain bounded pending task handles. */
	capacityBehavior?: 'reject' | 'queue'

	/** Maximum tasks awaiting admission across this manager. Defaults to 128. */
	maxPendingTasks?: number

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
