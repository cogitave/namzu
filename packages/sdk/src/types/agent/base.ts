import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
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
}

export type RuntimeToolOverrides = Record<string, ToolAvailability | 'disabled'>

export interface AgentRuntimeContext {
	label?: string
	outputDirectory?: string
	/**
	 * Optional working/scratch directory the runtime exposes to the
	 * agent — sibling to `outputDirectory`, invisible to the
	 * deliverables collector. Mirrors the Anthropic Cowork pattern
	 * where `/home/claude` is scratch and `/mnt/user-data/outputs` is
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
