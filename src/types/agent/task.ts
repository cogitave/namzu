import type { TokenUsage } from '../common/index.js'
import type { RunId, TaskId, ThreadId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { RunEventListener } from '../run/events.js'
import type { AgentInput, BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'
import type { AgentFactoryOptions } from './factory.js'

export type AgentTaskState =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'canceled'
	| 'rejected'
	| 'input-required'

export function isTerminalAgentTaskState(state: AgentTaskState): boolean {
	return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
}

export interface AgentTaskContext {
	parentRunId: RunId

	parentAgentId: string

	parentAbortController: AbortController

	depth: number

	budgetTracker: AgentTaskBudget

	factoryOptions?: AgentFactoryOptions

	threadId?: ThreadId
}

export interface AgentTaskBudget {
	total: number

	remaining: number
}

export interface AgentTask {
	taskId: TaskId
	agentId: string
	agent: Agent<BaseAgentConfig, BaseAgentResult>
	childAbortController: AbortController
	context: AgentTaskContext
	state: AgentTaskState
	result?: BaseAgentResult
	progress?: AgentTaskProgress

	pendingMessages: Message[]
	createdAt: number
	completedAt?: number

	evictAfter?: number

	runEventListener?: RunEventListener
}

export interface AgentTaskProgress {
	toolUseCount: number
	usage: TokenUsage
	recentActivities: string[]
}

export const MAX_RECENT_ACTIVITIES = 5

export interface SendMessageOptions {
	agentId: string

	input: AgentInput

	configOverrides?: Partial<BaseAgentConfig>

	budgetAllocation?: {
		tokenBudget?: number
		timeoutMs?: number
	}
}

export interface AgentManagerConfig {
	maxDepth: number

	evictionMs: number

	maxBudgetFraction: number
}

export const AGENT_MANAGER_DEFAULTS: Readonly<AgentManagerConfig> = {
	maxDepth: 3,
	evictionMs: 30_000,
	maxBudgetFraction: 0.5,
}
