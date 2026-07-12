import type { AgentInfo } from '../../contracts/index.js'
import type { TaskRouterConfig } from '../router/index.js'
import type { RetryConfig } from '../run/config.js'
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
	/**
	 * API key for providers that authenticate via key (OpenAI, Anthropic,
	 * OpenRouter). Optional because BYO-provider flows (Bedrock IAM, custom
	 * `ProviderRegistry.create(...)`) resolve credentials outside this object.
	 * `configBuilder` implementations should treat an absent `apiKey` as the
	 * BYO signal and use the provider passed via the agent config instead.
	 */
	apiKey?: string
	model?: string
	workingDirectory?: string
	tokenBudget?: number
	timeoutMs?: number
	temperature?: number
	maxResponseTokens?: number
	env?: Record<string, string>
	permissionMode?: 'plan' | 'auto'

	/** Retry / reactive-recovery policy threaded into the built agent config. */
	retry?: RetryConfig

	systemPrompt?: string

	provider?: 'openrouter' | 'bedrock'

	bedrockConfig?: {
		region?: string
		accessKeyId?: string
		secretAccessKey?: string
		sessionToken?: string
	}

	agentDefinitions?: AgentDefinition[]

	taskRouter?: TaskRouterConfig

	/**
	 * The run's own id, carried from whoever started the run into the config the
	 * builder returns. A builder that drops it lets the agent mint a second id for
	 * the same run (ses_017 P3) — thread it onto `BaseAgentConfig.runId`.
	 *
	 * NOT a child's id: `AgentManager.spawn` clears this before it builds a child,
	 * because a child is its own run and links back via `parentRunId`.
	 */
	runId?: string

	parentRunId?: string

	depth?: number
}
