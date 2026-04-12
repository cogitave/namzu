import type { AgentCapabilities } from '../../types/agent/base.js'
import type { AgentManagerConfig } from '../../types/agent/task.js'

export const MAX_RECENT_ACTIVITIES = 5

export const AGENT_MANAGER_DEFAULTS: Readonly<AgentManagerConfig> = {
	maxDepth: 3,
	evictionMs: 30_000,
	maxBudgetFraction: 0.5,
}

export const DEFAULT_CAPABILITIES: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}
