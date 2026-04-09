import type { AgentInfo } from '../../contracts/index.js'
import type { AgentContextLevel, BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'

export type { AgentContextLevel } from './base.js'

export interface AgentDefinition {
	info: AgentInfo
	typedAgent: Agent<BaseAgentConfig, BaseAgentResult>
	configBuilder?: (options: AgentFactoryOptions) => BaseAgentConfig | Promise<BaseAgentConfig>

	contextLevel?: AgentContextLevel
}

export interface AgentFactoryOptions {
	apiKey: string
	model?: string
	workingDirectory?: string
	tokenBudget?: number
	timeoutMs?: number
	temperature?: number
	maxResponseTokens?: number
	env?: Record<string, string>
	permissionMode?: 'plan' | 'auto'

	systemPrompt?: string

	provider?: 'openrouter' | 'bedrock'

	bedrockConfig?: {
		region?: string
		accessKeyId?: string
		secretAccessKey?: string
		sessionToken?: string
	}

	agentDefinitions?: AgentDefinition[]

	threadId?: string

	runId?: string

	parentRunId?: string

	depth?: number
}
