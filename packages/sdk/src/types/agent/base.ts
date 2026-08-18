import type { Logger } from '../../utils/logger.js'
import type { CostInfo, RunExecutionStatus, TokenUsage } from '../common/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { Message } from '../message/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { StopReason } from '../run/stop-reason.js'
import type { ProjectId, TopicId } from '../session/ids.js'
import type { TaskStore } from '../task/index.js'
import type { ToolAvailability } from '../tool/index.js'

export type AgentType = 'reactive' | 'pipeline' | 'router' | 'supervisor'

export type AgentContextLevel = 'full' | 'standard' | 'minimal'

export interface BaseAgentConfig {
	model: string
	tokenBudget: number
	timeoutMs: number
	/** See {@link import('../run/config.js').AgentRunConfig.streamIdleTimeoutMs}. */
	streamIdleTimeoutMs?: number
	maxIterations?: number
	temperature?: number
	maxResponseTokens?: number
	costLimitUsd?: number
	permissionMode?: PermissionMode

	/**
	 * The tools this run may use, narrowing whatever its registry holds.
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
	 * Text queued for this run since its last turn, drained at the boundary.
	 *
	 * A callback rather than an array, because the queue is owned by
	 * whoever accepts the messages — `AgentManager` for a delegated child, a
	 * host for a top-level run — and an array captured at config time would
	 * be whatever was queued before the run started.
	 *
	 * It exists because two public APIs could accept text and silently never
	 * deliver it. `AgentManager.continueTask` and `queueMessage` pushed onto
	 * `pendingMessages` and nothing in the kernel ever drained it — the
	 * manager interface's own docblock said so, and `continue_task` was
	 * unmounted from the coordinator tools because of it. The steering
	 * channel had the mirror-image hole: it can only ride on a tool result,
	 * so guidance queued during a turn that called no tools stayed pending
	 * until the run ended.
	 */
	inboundMessages?: () => import('../message/index.js').Message[]

	allowedTools?: readonly string[]

	/**
	 * Tools this run may NOT use, subtracted from whatever it would
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

	/** Persona for this run, overriding what the agent's definition supplies. */
	persona?: import('../persona/index.js').AgentPersona

	/**
	 * Override the logger this run's `AbstractAgent.bindRun` uses instead of
	 * the logger the agent was CONSTRUCTED with. Same reason `thinking` and
	 * `effort` are declared here rather than per-config: every concrete agent
	 * builds its `runConfig` by hand-listing fields, and a field absent from a
	 * hand-listed literal is dropped in silence. A host that wants one run's
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
	 * and enters a model's context and the run transcript the moment something
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
	 * makes. See {@link import('../run/config.js').AgentRunConfig} for what
	 * each one controls and why they are siblings.
	 *
	 * They are declared HERE, on the shared base, rather than on each agent
	 * config that happens to want them. Every agent builds its `AgentRunConfig`
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
	 * Long-lived goal scope for the run. Required at runtime — agents reject
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
	 * Topic the run belongs to. Optional at the TYPE level for the same
	 * reason as `projectId` — {@link AgentManager} stamps this field after
	 * `configBuilder` returns so `configBuilder` implementations do not
	 * need to be updated before this tightens. Tightening to required
	 * lands with the `AgentFactoryOptions` triple refactor.
	 */
	topicId?: TopicId

	/** Session under which the run executes. See `projectId` for the tightening plan. */
	sessionId?: SessionId

	/** Isolation boundary (Convention #17). See `projectId` for the tightening plan. */
	tenantId?: TenantId

	parentRunId?: RunId

	depth?: number

	contextLevel?: AgentContextLevel

	/** Shared invocation state passed through agent hierarchies */
	invocationState?: InvocationState

	/** Span a delegated run hangs off. Absent for a top-level run. */
	parentSpan?: import('@opentelemetry/api').Span

	/**
	 * Where this agent takes a decision it cannot make alone — a tool that
	 * needs approval, a question for a human, a plan to sign off.
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
	 * Absent still means auto-approve, so a host that never wired one is
	 * unaffected.
	 */
	resumeHandler?: ResumeHandler
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

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides

	runtimeContext?: AgentRuntimeContext
}

export interface BaseAgentResult {
	runId: RunId
	status: RunExecutionStatus
	stopReason?: StopReason
	usage: TokenUsage
	cost: CostInfo
	iterations: number
	durationMs: number
	messages: Message[]
	result?: string
	/**
	 * The schema-validated answer, when the run was configured to produce one.
	 *
	 * `Run.structuredOutput` has carried this all along and every ergonomic
	 * boundary above it dropped the value three lines from its caller: an
	 * archetype's result literal did not copy it, `runAgent` did not even
	 * forward the config that produces it, and both delegation tools handed a
	 * parent the child's prose. So a supervisor fanning out to five
	 * schema-configured specialists received five strings and had to make the
	 * model re-parse what it had just caused to be serialized.
	 *
	 * `unknown` rather than a generic, deliberately. The schema lives on the
	 * run's config and a result type parameter would have to be threaded
	 * through every archetype, both delegation tools and the task record to
	 * reach here — and at the delegation boundary the parent does not hold the
	 * child's schema anyway, so the parameter would be `unknown` again at the
	 * only place it was wanted. Narrow it at the call site with the schema you
	 * already have.
	 */
	structuredOutput?: unknown
	lastError?: string
}

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
