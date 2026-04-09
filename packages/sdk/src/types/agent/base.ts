import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId, ThreadId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { StopReason } from '../run/index.js'
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

	threadId?: ThreadId

	parentRunId?: RunId

	depth?: number

	contextLevel?: AgentContextLevel
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
