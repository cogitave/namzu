import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId, TaskId, TenantId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'
import type { StopReason } from './stop-reason.js'

/**
 * Denormalized metadata for a run.
 *
 * `projectId` and `tenantId` are required per Convention #17 — every run is
 * attributed to a Project within a Tenant.
 */
export interface RunMetadata {
	id: RunId
	/** Long-lived goal scope. Required. */
	projectId: ProjectId
	/** Isolation boundary (Convention #17). Required. */
	tenantId: TenantId
	agentId: string
	agentName: string
	status: AgentStatus
	config: RunConfigSnapshot
	provider: string

	parentRunId?: RunId
	taskId?: TaskId
	depth: number

	tokenUsage: TokenUsage
	costInfo: CostInfo
	iterations: number
	startedAt: number
	endedAt?: number
	durationMs?: number
	stopReason?: StopReason
	lastError?: string
	result?: string

	childRunIds?: RunId[]
}

export interface RunConfigSnapshot {
	model: string
	tokenBudget: number
	timeoutMs: number
	maxIterations?: number
	temperature?: number
	maxResponseTokens?: number
	costLimitUsd?: number
}
