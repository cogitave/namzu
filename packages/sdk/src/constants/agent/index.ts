import type { AgentCapabilities } from '../../types/agent/base.js'
import type { AgentManagerConfig } from '../../types/agent/task.js'

/**
 * **Nothing reads this.** No activity list is trimmed to it anywhere.
 *
 * @deprecated Unused. Removed in the next major.
 */
export const MAX_RECENT_ACTIVITIES = 5

export const AGENT_MANAGER_DEFAULTS: Readonly<AgentManagerConfig> = {
	maxDepth: 3,
	evictionMs: 30_000,
	maxBudgetFraction: 0.5,
	// Five minutes. Generous for a delegated sub-task, bounded enough that a
	// wedged child cannot hold its parent open indefinitely.
	childTimeoutMs: 300_000,
}

export const DEFAULT_CAPABILITIES: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}
