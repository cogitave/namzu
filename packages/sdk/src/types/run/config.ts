import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { RunId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'

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

export interface RunPersistenceConfig {
	runId: RunId
	agentId: string
	agentName: string
	runConfig: AgentRunConfig
	providerId: string
	outputDir: string
	pricing?: ModelPricing
	log: Logger

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

/** @deprecated Use AgentRunConfig directly */
export type SessionConfig = AgentRunConfig

/** @deprecated Use RunPersistenceConfig directly */
export type SessionManagerConfig = RunPersistenceConfig

/** @deprecated Use RunStoreConfig directly */
export type SessionStoreConfig = RunStoreConfig
