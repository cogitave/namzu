import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { AgentRunConfig } from './config.js'
import type { StopReason } from './stop-reason.js'

export interface RunStateMetadata {
	agentId: string
	agentName: string
	config: AgentRunConfig
	provider: string
}

export type SessionMetadata = RunStateMetadata

export interface AgentRun {
	id: RunId
	status: AgentStatus
	metadata: RunStateMetadata
	messages: Message[]
	tokenUsage: TokenUsage
	costInfo: CostInfo
	currentIteration: number
	startedAt: number
	endedAt?: number
	stopReason?: StopReason
	lastError?: string
	result?: string

	parentRunId?: RunId

	depth?: number
}

export type AgentSession = AgentRun
