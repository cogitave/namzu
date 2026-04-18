import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId } from '../session/ids.js'

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
 * Config for {@link RunPersistence}. `sessionId`, `tenantId`, and `projectId`
 * are required — every Run is attributed to a Session under a Project within
 * a Tenant (Convention #17).
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
