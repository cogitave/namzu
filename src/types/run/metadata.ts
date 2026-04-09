import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId, TaskId, ThreadId } from '../ids/index.js'
import type { StopReason } from './events.js'

export interface RunMetadata {
	id: RunId
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
