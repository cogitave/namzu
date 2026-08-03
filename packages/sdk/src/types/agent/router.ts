import type { TokenUsage } from '../common/index.js'
import type { LLMProvider } from '../provider/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'

export type RoutingDecisionSource = 'provider' | 'fallback' | 'hard_fail'

export interface RoutingDecision {
	agentId: string
	confidence: number
	reasoning?: string
	routingSource: RoutingDecisionSource
	/**
	 * Tokens the routing call itself spent, summed over any retries.
	 *
	 * Routing runs before the delegate's run exists, so it has no
	 * `RunPersistence` to accumulate into. Reporting it here lets the
	 * router fold it into the result it returns, instead of the caller
	 * seeing only the delegate's usage and under-reporting every routed
	 * run by one model call.
	 */
	usage?: TokenUsage
}

export interface RouteDefinition {
	agentId: string
	agent: Agent<BaseAgentConfig, BaseAgentResult>
	description: string
	matchPatterns?: string[]
}

export interface RouterAgentConfig extends BaseAgentConfig {
	routes: RouteDefinition[]
	provider: LLMProvider
	routingPrompt?: string
	fallbackAgentId?: string
	minConfidence?: number
	maxRoutingRetries?: number
}

export interface RouterAgentResult extends BaseAgentResult {
	selectedRoute: string
	routingDecision: RoutingDecision
	delegateResult: BaseAgentResult
}
