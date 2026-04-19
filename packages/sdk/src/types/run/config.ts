import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'

export interface AgentRunConfig {
	model: string
	timeoutMs: number
	maxResponseTokens?: number
	tokenBudget: number
	costLimitUsd?: number
	maxIterations?: number
	temperature?: number
	env?: Record<string, string>
	permissionMode?: PermissionMode
	sandbox?: {
		timeoutMs?: number
		memoryLimitMb?: number
		maxProcesses?: number
	}
}

/**
 * Config for {@link RunPersistence}. `sessionId`, `threadId`, `tenantId`,
 * and `projectId` are required — every Run is attributed across the full
 * five-layer scope (Tenant → Project → Thread → Session → Run,
 * Convention #17).
 */
export interface RunPersistenceConfig {
	runId: RunId
	agentId: string
	agentName: string
	runConfig: AgentRunConfig
	providerId: string
	outputDir: string
	pricing?: ModelPricing
	log: Logger

	sessionId: SessionId
	threadId: ThreadId
	tenantId: TenantId
	projectId: ProjectId

	parentRunId?: RunId

	depth?: number
}

export interface RunStoreConfig {
	baseDir: string
	logger?: Logger
}

export interface LimitCheckerConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations: number
	budgetWarningThreshold: number
}
