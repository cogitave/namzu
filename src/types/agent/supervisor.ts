import type { AdvisoryConfig } from '../advisory/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { TaskRouterConfig } from '../router/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { AgentFactoryOptions } from './factory.js'
import type { TaskGateway } from './gateway.js'
import type { AgentManagerContract } from './manager.js'

export interface SupervisorAgentConfig extends BaseAgentConfig {
	provider: LLMProvider

	agentIds: string[]

	gateway?: TaskGateway
	agentManager?: AgentManagerContract

	systemPrompt: string

	maxDepth?: number

	taskRouter?: TaskRouterConfig

	factoryOptions?: AgentFactoryOptions

	advisory?: AdvisoryConfig
}

export interface AgentTaskResult {
	agentId: string
	result: BaseAgentResult
	taskIndex: number
}

export interface SupervisorAgentResult extends BaseAgentResult {
	taskResults: AgentTaskResult[]
	completedTasks: number
	totalTasks: number
}
