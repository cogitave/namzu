import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId, SessionId, TenantId, ThreadId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { Message } from '../message/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { StopReason } from '../run/stop-reason.js'
import type { ProjectId } from '../session/ids.js'
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
	 * @deprecated Use `projectId`. Kept as a migration-window mirror; when both
	 * are present `projectId` wins. See session-hierarchy.md §13.1.
	 */
	threadId?: ThreadId

	/**
	 * Long-lived goal scope for the run. Required at runtime in 0.2.0 per
	 * session-hierarchy.md §12.1 — `{@link ReactiveAgent}`, `{@link
	 * SupervisorAgent}`, etc. reject configs missing this (`'X requires
	 * sessionId, projectId, and tenantId in config (§12.1)'`).
	 *
	 * Kept optional at the TYPE level during the 0.2.x migration window
	 * because {@link AgentManager} stamps this field AFTER `configBuilder`
	 * returns (manager/agent/lifecycle.ts:228–230). That stamping path is
	 * how every `@namzu/agents` configBuilder currently gets its tenant /
	 * session / project triple; flipping the type to required without first
	 * updating every {@link AgentFactoryOptions} consumer (which does not
	 * carry these fields) would be a gratuitous downstream break.
	 *
	 * Tightening to required is Phase 9 Known Delta #6. The type-level flip
	 * lands in 0.3.0 alongside `AgentFactoryOptions` gaining the triple.
	 */
	projectId?: ProjectId

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

export interface AgentInput {
	messages: Message[]
	workingDirectory: string
	signal?: AbortSignal

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides
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
