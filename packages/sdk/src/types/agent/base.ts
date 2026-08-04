import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { ResumeHandler } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { Message } from '../message/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { StopReason } from '../run/stop-reason.js'
import type { ProjectId, ThreadId } from '../session/ids.js'
import type { TaskStore } from '../task/index.js'
import type { ToolAvailability } from '../tool/index.js'

export type AgentType = 'reactive' | 'pipeline' | 'router' | 'supervisor'

export type AgentContextLevel = 'full' | 'standard' | 'minimal'

export interface BaseAgentConfig {
	model: string
	tokenBudget: number
	timeoutMs: number
	maxIterations?: number
	temperature?: number
	maxResponseTokens?: number
	costLimitUsd?: number
	permissionMode?: PermissionMode
	env?: Record<string, string>

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
	threadId?: ThreadId

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
	 * stating exactly. A `VerificationGate` DENY still bites inside a
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
	status: AgentStatus
	stopReason?: StopReason
	usage: TokenUsage
	cost: CostInfo
	iterations: number
	durationMs: number
	messages: Message[]
	result?: string
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
