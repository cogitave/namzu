import type { AdvisoryConfig } from '../advisory/index.js'
import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { Skill } from '../skills/index.js'
import type { ToolRegistryContract } from '../tool/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'

export interface ReactiveAgentConfig extends BaseAgentConfig {
	systemPrompt?: string

	persona?: AgentPersona

	skills?: Skill[]

	basePrompt?: string
	provider: LLMProvider
	tools: ToolRegistryContract

	advisory?: AdvisoryConfig
}

export interface ReactiveAgentResult extends BaseAgentResult {
	toolCallCount: number
}
