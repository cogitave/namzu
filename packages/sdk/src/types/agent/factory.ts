import type { AgentInfo } from '../../contracts/index.js'
import type { TaskRouterConfig } from '../router/index.js'
import type { AgentContextLevel, BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'

export type { AgentContextLevel } from './base.js'

export interface AgentDefinition {
	info: AgentInfo
	typedAgent: Agent<BaseAgentConfig, BaseAgentResult>

	/**
	 * Build a fresh agent for a single spawn.
	 *
	 * `typedAgent` is ONE instance, and an instance refuses a second
	 * concurrent run because it holds per-run state. So a delegation fan-out
	 * naming the same `agent_id` four times ran one child and lost three to
	 * `ConcurrentInvocationError` — while `create_task`'s own description tells
	 * a model that exactly this fan-out is the thing to do.
	 *
	 * The manager prefers this over `typedAgent` for every spawn. Supply it
	 * when your agent needs real construction arguments; agents built on
	 * `AbstractAgent` already get a working default from `Agent.forRun`, so
	 * most hosts need nothing here.
	 *
	 * `configBuilder` is not a substitute: it produces a fresh CONFIG per
	 * spawn, and the config was never the part being shared.
	 */
	createAgent?: () => Agent<BaseAgentConfig, BaseAgentResult>

	configBuilder?: (options: AgentFactoryOptions) => BaseAgentConfig | Promise<BaseAgentConfig>

	contextLevel?: AgentContextLevel
}

export interface AgentFactoryOptions {
	/**
	 * API key for providers that authenticate via a key. Optional because
	 * BYO-provider flows (ambient cloud credentials, a custom
	 * `ProviderRegistry.create(...)`) resolve credentials outside this object.
	 * `configBuilder` implementations should treat an absent `apiKey` as the
	 * BYO signal and use the provider passed via the agent config instead.
	 */
	apiKey?: string
	model?: string
	workingDirectory?: string
	tokenBudget?: number
	timeoutMs?: number
	streamIdleTimeoutMs?: number
	maxRequestRichContentBytes?: number
	attachmentResolveTimeoutMs?: number
	temperature?: number
	maxResponseTokens?: number
	env?: Record<string, string>
	permissionMode?: 'plan' | 'auto'

	systemPrompt?: string

	/**
	 * Which registered provider to build. Any type registered with
	 * `ProviderRegistry` is valid — this was a closed two-member union
	 * naming two specific services, which the registry has never been
	 * limited to and which no caller could extend.
	 */
	provider?: string

	/**
	 * Extra construction config for the chosen provider, passed through
	 * untouched. Replaces a field that existed for exactly one service and
	 * had no construction site anywhere.
	 */
	providerConfig?: Record<string, unknown>

	agentDefinitions?: AgentDefinition[]

	taskRouter?: TaskRouterConfig

	runId?: string

	parentRunId?: string

	depth?: number
}
