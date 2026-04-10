import type { AgentPersona } from '../persona/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { AdvisoryTrigger } from './trigger.js'

export interface AdvisorDefinition {
	readonly id: string
	readonly name: string
	readonly provider: LLMProvider
	readonly model: string
	readonly domains?: string[]
	readonly persona?: AgentPersona
	readonly systemPrompt?: string
	readonly maxContextTokens?: number
	readonly useCompactedContext?: boolean
	readonly maxResponseTokens?: number
	readonly temperature?: number
}

export interface AdvisoryBudget {
	readonly maxCallsPerRun?: number
	readonly maxCallsPerSession?: number
	readonly maxCostPerCall?: number
	readonly maxCostPerRun?: number
	readonly maxCostPerSession?: number
	readonly maxTokensPerCall?: number
}

export interface AdvisoryConfig {
	readonly advisors: AdvisorDefinition[]
	readonly defaultAdvisorId?: string
	readonly budget?: AdvisoryBudget
	readonly triggers?: AdvisoryTrigger[]
	readonly enableAgentTool?: boolean
	readonly includeToolCatalog?: boolean
}
