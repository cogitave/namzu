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
}

export interface RunPersistenceConfig {
	runId: RunId
	agentId: string
	agentName: string
	sessionConfig: AgentRunConfig
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

export type SessionConfig = AgentRunConfig

export type SessionManagerConfig = RunPersistenceConfig

export type SessionStoreConfig = RunStoreConfig
