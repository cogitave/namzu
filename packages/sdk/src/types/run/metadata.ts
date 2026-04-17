import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId, TaskId, TenantId, ThreadId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'
import type { StopReason } from './stop-reason.js'

/**
 * Denormalized metadata for a run.
 *
 * See session-hierarchy.md §4.6, §10.1, and §12.1.
 *
 * 0.2.0 promotes `projectId` and `tenantId` to required fields. `threadId`
 * remains as a deprecated mirror of `projectId` for the 0.2.x migration
 * window — consumers should prefer `projectId` and fall back to `threadId`
 * only for legacy records. 0.3.x removes `threadId` entirely (§13.1).
 */
export interface RunMetadata {
	id: RunId
	/**
	 * Long-lived goal scope. Required in 0.2.0. Replaces the root-scope role
	 * `threadId` played in 0.1.x.
	 */
	projectId: ProjectId
	/** Isolation boundary (Convention #17). Required in 0.2.0. */
	tenantId: TenantId
	/**
	 * @deprecated Use {@link RunMetadata.projectId}. Mirror retained for the
	 * 0.2.x migration window; scheduled for removal in 0.3.0 per
	 * session-hierarchy.md §13.1.
	 */
	threadId: ThreadId
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
