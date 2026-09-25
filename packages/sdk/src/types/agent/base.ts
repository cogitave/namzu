import type { ProjectInstructionContext } from '../../runtime/query/project-instructions.js'
import type { SessionPaths } from '../../session/paths.js'
import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type { Logger } from '../../utils/logger.js'
import type { CostInfo, TokenUsage } from '../common/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { Message } from '../message/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId, TopicId } from '../session/ids.js'
import type { StopReason } from '../session/stop-reason.js'
import type { TurnExecutionStatus } from '../session/turn.js'
import type { TaskStore } from '../task/index.js'
import type { ToolAvailability } from '../tool/index.js'

/** Application-owned agent kind; the SDK does not prescribe an agent taxonomy. */
export type AgentType = string

export type AgentContextLevel = 'full' | 'standard' | 'minimal'

export interface BaseAgentConfig {
	model: string
	tokenBudget: number
	/** Aggregate authority inherited by descendants; supplied independently of the numeric local cap. */
	budget?: SessionTokenBudget
	timeoutMs: number
	/** See {@link import('../session/config.js').TurnConfig.streamIdleTimeoutMs}. */
	streamIdleTimeoutMs?: number
	/** See {@link import('../session/config.js').TurnConfig.maxRequestRichContentBytes}. */
	maxRequestRichContentBytes?: number
	/** Maximum stored-attachment materialization time; defaults to one minute. `0` disables. */
	attachmentResolveTimeoutMs?: number
	maxIterations?: number
	temperature?: number
	maxResponseTokens?: number
	costLimitUsd?: number
	permissionMode?: PermissionMode
	/**
	 * Checkpoint retention for this agent's turn. See
	 * {@link import('../session/config.js').TurnConfig.pruneKeepLast}; absent
	 * keeps every checkpoint, as before.
	 */
	pruneKeepLast?: number

	/**
	 * The durable layout for this agent invocation: where its session log,
	 * checkpoints, ledgers and tasks live (`~/.namzu/projects/<slug>/…`).
	 *
	 * Absent: `SessionPaths` under `resolveNamzuHome()`, unless
	 * {@link BaseAgentConfig.sessionLog} is an `InMemorySessionLog`, in which
	 * case the session writes nothing to disk.
	 */
	paths?: SessionPaths

	/**
	 * The session log this agent's turns append to. See `QueryParams.sessionLog`.
	 *
	 * An `InMemorySessionLog` with no `paths` keeps the whole session in
	 * memory: its checkpoints and its token ledger too, and every child
	 * session it delegates to (`AgentTaskContext.childStorage`).
	 */
	sessionLog?: SessionLog

	/**
	 * Where this agent's turns keep their checkpoints. See
	 * `QueryParams.checkpointStore`.
	 */
	checkpointStore?: SessionCheckpointStore

	/**
	 * Turn-level sandbox limits and workspace ownership.
	 *
	 * A provider alone only says HOW commands are confined. This field says
	 * WHAT it is rooted at; `working-directory` makes sandbox-aware tools act
	 * on the turn's declared workspace instead of a disposable empty tree.
	 */
	sandbox?: import('../session/config.js').TurnConfig['sandbox']

	/**
	 * The tools this turn may use, narrowing whatever its registry holds.
	 *
	 * `allowedTools` existed on `QueryParams` and on `ToolContext` and
	 * nowhere on the path a delegation takes — so a supervisor handing a
	 * read-only research subtask to an agent whose definition also grants
	 * `write` and `bash` had no way to say so. The child ran with
	 * everything the agent had.
	 *
	 * `query()` binds this to BOTH the request tool list and the
	 * `ToolExecutor`, which is what makes it enforced rather than
	 * presentational: narrowing only the request showed the model fewer
	 * tools and let it call any of them by name.
	 */
	/**
	 * Text queued for this turn since its last turn, drained at the boundary.
	 *
	 * A callback rather than an array, because the queue is owned by
	 * whoever accepts the messages — `AgentManager` for a delegated child, a
	 * host for a top-level turn — and an array captured at config time would
	 * be whatever was queued before the turn started.
	 *
	 * It exists because two public APIs could accept text and silently never
	 * deliver it. `AgentManager.continueTask` and `queueMessage` pushed onto
	 * `pendingMessages` and nothing in the kernel ever drained it — the
	 * manager interface's own docblock said so, and `continue_task` was
	 * unmounted from the coordinator tools because of it. The steering
	 * channel had the mirror-image hole: it can only ride on a tool result,
	 * so guidance queued during a turn that called no tools stayed pending
	 * until the turn ended.
	 */
	inboundMessages?: () => import('../message/index.js').Message[]

	/** Live project policy, flushed independently of human continuation text. */
	projectInstructionContext?: ProjectInstructionContext

	allowedTools?: readonly string[]

	/**
	 * Screens to run against every tool result, in this agent and in the
	 * agents it delegates to.
	 *
	 * See {@link import('../../runtime/query/index.js').QueryParams.toolResultGuardrails}.
	 * On the BASE config rather than one agent's, because a delegated child is
	 * a fresh turn with its own executor: a switch that reached this agent and
	 * not its children would leave the default on in exactly the half a host
	 * would be trying to change. Absent installs the shipped default; an empty
	 * array installs none.
	 *
	 * **The inheritance is the manager's, not the child definition's.** A
	 * `configBuilder` is written by whoever registered the agent and cannot be
	 * expected to forward a field it was never told about, so `AgentManager`
	 * stamps this onto the child config after the builder returns — the same
	 * shape as `parentSpan`, `resumeHandler` and `env`. The value it stamps is
	 * the spawning context's (`AgentTaskContext.toolResultGuardrails`), which
	 * `SupervisorAgent` fills from this field and the delegation tools fill
	 * from the turn's own `ToolContext`; a spawn that supplies
	 * `configOverrides.toolResultGuardrails` replaces it rather than merging,
	 * so a host can still hand one child a different set — including none.
	 */
	toolResultGuardrails?: readonly import('../guardrail/index.js').ToolResultGuardrailSpec[]

	/**
	 * Tools this turn may NOT use, subtracted from whatever it would
	 * otherwise have.
	 *
	 * Separate from `allowedTools` because they answer different
	 * questions and a delegation needs the second. `allowedTools` absent
	 * means "everything the registry holds", so a caller narrowing a child
	 * would otherwise have to enumerate the agent's whole tool set to
	 * remove one from it — and would then silently pin that list against
	 * an agent that later gains a tool.
	 */
	deniedTools?: readonly string[]

	/** Persona for this turn, overriding what the agent's definition supplies. */
	persona?: import('../persona/index.js').AgentPersona

	/**
	 * Override the logger this turn uses instead of the logger the agent was
	 * CONSTRUCTED with. Same reason `thinking` and `effort` are declared here
	 * rather than per-config: every concrete agent builds its `turnConfig` by
	 * hand-listing fields, and a field absent from a hand-listed literal is
	 * dropped in silence. A host that wants one turn's
	 * output routed differently — without reconstructing the agent — sets this.
	 */
	logger?: Logger

	/**
	 * Extra environment variables for this agent's tools and sandboxed
	 * commands, merged over whatever ambient environment the execution path
	 * supplies. Inherited by every delegated descendant.
	 *
	 * **Configuration, not credentials** — and that is a property of the
	 * CHANNEL rather than a judgement about any particular value. This map is
	 * copied into every child, is readable by any tool that can run a command,
	 * and enters a model's context and the turn transcript the moment something
	 * echoes it. Nothing here is scoped, redacted, or revocable.
	 *
	 * A value that authenticates to a host belongs on the brokered credential
	 * path instead, where the process holds a placeholder and the real value is
	 * attached per-host on egress — so it is never in the environment, never in
	 * a transcript, and never inherited by a child that had no business with it.
	 *
	 * Inheritance was broken until it was not: a child built through a
	 * `configBuilder` never received this at all, because the builder is
	 * written by whoever registered the agent and cannot forward a field it was
	 * never told about. It is stamped after the builder returns now, for the
	 * same reason `parentSpan` and `resumeHandler` are.
	 */
	env?: Record<string, string>

	/**
	 * Thinking mode and response-effort level for every model call this agent
	 * makes. See {@link import('../session/config.js').TurnConfig} for what
	 * each one controls and why they are siblings.
	 *
	 * They are declared HERE, on the shared base, rather than on each agent
	 * config that happens to want them. Every agent builds its `TurnConfig`
	 * by hand-listing fields, and a field absent from a hand-listed literal is
	 * dropped in silence — which is exactly how `thinking` came to be settable
	 * only through the raw kernel entry point while every ergonomic one quietly
	 * ignored it. Putting them on the base is what makes "did you forget to
	 * forward it" a type error in the places that matter rather than a support
	 * question.
	 */
	thinking?: import('../provider/index.js').ThinkingConfig
	effort?: import('../provider/index.js').ReasoningEffort

	/**
	 * Deduplicate a retried invocation instead of running it twice.
	 *
	 * The failure this exists for: a caller sends a request, the
	 * connection drops, the caller retries. Without a key the retry is a
	 * second full run — a second set of model calls, and a second set of
	 * whatever the tools did. A duplicate arriving while the first is
	 * still running awaits it and receives its result, error included.
	 *
	 * In-flight only. A retry that arrives after the first has settled
	 * runs again, because keeping the answer would turn deduplication
	 * into caching and staleness is the host's judgement, not the SDK's.
	 * Instance-scoped, like the invocation lock: deduplicating across
	 * processes needs somewhere durable to record the key.
	 */
	idempotencyKey?: string

	/**
	 * Long-lived goal scope for the turn. Required at runtime — agents reject
	 * configs missing this (`'X requires sessionId, projectId, and tenantId
	 * in config'`).
	 *
	 * Kept optional at the TYPE level because {@link AgentManager} stamps
	 * this field AFTER `configBuilder` returns (manager/agent/lifecycle.ts).
	 * Tightening to required is a separate task alongside
	 * `AgentFactoryOptions` carrying the triple.
	 */
	projectId?: ProjectId

	/**
	 * Topic the turn belongs to. Optional at the TYPE level for the same
	 * reason as `projectId` — {@link AgentManager} stamps this field after
	 * `configBuilder` returns so `configBuilder` implementations do not
	 * need to be updated before this tightens. Tightening to required
	 * lands with the `AgentFactoryOptions` triple refactor.
	 */
	topicId?: TopicId

	/** Session under which the turn executes. See `projectId` for the tightening plan. */
	sessionId?: SessionId

	/** Isolation boundary (Convention #17). See `projectId` for the tightening plan. */
	tenantId?: TenantId

	/** Present on a child session: the session that delegated it. */
	parentSessionId?: SessionId

	/** Present on a child session: the parent turn whose tool call spawned it. */
	parentTurnId?: TurnId

	depth?: number

	contextLevel?: AgentContextLevel

	/** Shared invocation state passed through agent hierarchies */
	invocationState?: InvocationState

	/** Span a delegated session hangs off. Absent for a top-level turn. */
	parentSpan?: import('@opentelemetry/api').Span

	/**
	 * Where this agent takes a decision it cannot make alone — a tool that
	 * needs approval, a root-agent question for a human, a plan to sign off.
	 *
	 * Declared HERE, on the base config, rather than only on the agent
	 * shapes that happened to want it. `AgentManager` builds a child as a
	 * `BaseAgentConfig` and `SendMessageOptions.configOverrides` is a
	 * `Partial` of it, so a field further down the hierarchy is one a
	 * spawn cannot express AT THE TYPE LEVEL — and that is what happened:
	 * every delegated child fell through to the SDK's `autoApproveHandler`
	 * however carefully its parent had been wired.
	 *
	 * What that cost is narrower than "no gate in children" and worth
	 * stating exactly. A `AuthorizationGate` DENY still bites inside a
	 * child, because denials are threaded into the executor and no later
	 * approval releases them. What was lost is the REVIEW tier: every call
	 * the gate left undecided went to the resume handler, and for a child
	 * that handler auto-approved. So a host running "ask before acting"
	 * had a human review `write` at the top level and never see the same
	 * `write` issued one hop down.
	 *
	 * A delegated agent inherits this channel for review but does not gain the
	 * root-only `ask_user_question` tool. Absent still means auto-approve, so a
	 * host that never wired one is unaffected.
	 */
	resumeHandler?: ResumeHandler

	/**
	 * Whether a batch that needs no review still goes to `resumeHandler`, in
	 * this agent's turn and in every turn it delegates to. See
	 * {@link import('../../runtime/query/index.js').QueryParams.reviewAllowedCalls}.
	 *
	 * A delegated child borrows its parent's handler, and a handler that
	 * refuses a change in a read-only mode (`plan`) cannot refuse a batch that
	 * never reaches it: one a rule allows, or one an approval given earlier in
	 * the CHILD's turn covers. So `AgentManager` stamps the spawning context's
	 * function (`AgentTaskContext.reviewAllowedCalls`) onto the child config
	 * after the builder returns, the same way it stamps the handler.
	 *
	 * Passed as a function and read once per batch, so a mode the operator
	 * enters while a child is already running reaches that child's next batch.
	 *
	 * **It only ever adds review.** A value the child config sets itself (from
	 * its `configBuilder` or `configOverrides`) is kept, and consulted together
	 * with the inherited one: the child's batch goes to review when EITHER
	 * says so. A child can ask for more review than its parent; it cannot
	 * answer `false` over a parent that answers `true`.
	 *
	 * Absent, and nothing inherited: rule-allowed and grant-covered batches run
	 * without asking, as they always have.
	 */
	reviewAllowedCalls?: () => boolean
}

export type RuntimeToolOverrides = Record<string, ToolAvailability | 'disabled'>

export interface AgentRuntimeContext {
	label?: string
	outputDirectory?: string
	/**
	 * Optional working/scratch directory the runtime exposes to the
	 * agent — sibling to `outputDirectory`, invisible to the
	 * output collector. Follows the same separation as the container layout
	 * where the scratch bind is invisible and `/mnt/user-data/outputs` is
	 * user-visible.
	 */
	scratchDirectory?: string
	outputFileMarker?: string
	notes?: readonly string[]
}

export interface AgentInput {
	messages: Message[]
	workingDirectory: string
	signal?: AbortSignal
	/** Store that owns any `stored` attachment refs carried by `messages`. */
	attachmentStore?: import('../../store/attachment/index.js').AttachmentStore

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides

	runtimeContext?: AgentRuntimeContext
}

export interface BaseAgentResult {
	/** Aggregate tree accounting, separate from this invocation's own usage. */
	budget?: ReturnType<SessionTokenBudget['summary']>

	sessionId: SessionId
	turnId: TurnId
	status: TurnExecutionStatus
	stopReason?: StopReason
	usage: TokenUsage
	cost: CostInfo
	iterations: number
	durationMs: number
	messages: Message[]
	result?: string
	/**
	 * The schema-validated answer, when the turn was configured to produce one.
	 *
	 * `Turn.structuredOutput` has carried this all along and every ergonomic
	 * boundary above it dropped the value three lines from its caller: an
	 * archetype's result literal did not copy it, `runAgent` did not even
	 * forward the config that produces it, and both delegation tools handed a
	 * parent the child's prose. So a supervisor fanning out to five
	 * schema-configured specialists received five strings and had to make the
	 * model re-parse what it had just caused to be serialized.
	 *
	 * `unknown` rather than a generic, deliberately. The schema lives on the
	 * turn's config and a result type parameter would have to be threaded
	 * through every archetype, both delegation tools and the task record to
	 * reach here — and at the delegation boundary the parent does not hold the
	 * child's schema anyway, so the parameter would be `unknown` again at the
	 * only place it was wanted. Narrow it at the call site with the schema you
	 * already have.
	 */
	structuredOutput?: unknown
	lastError?: string
}

/** Descriptive metadata. Access and concurrency are enforced by the host and runtime seams. */
export interface AgentCapabilities {
	supportsTools: boolean
	supportsStreaming: boolean
	supportsConcurrency: boolean
	supportsSubAgents: boolean
}

export interface AgentMetadata {
	type: AgentType
	id: string
	name: string
	version: string
	category: string
	description: string
	capabilities: AgentCapabilities
}
