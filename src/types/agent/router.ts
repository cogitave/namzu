import type { LLMProvider } from '../provider/index.js'
import type { BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'

export type RoutingDecisionSource = 'provider' | 'fallback' | 'hard_fail'

export interface RoutingDecision {
	agentId: string
	confidence: number
	reasoning?: string
	routingSource: RoutingDecisionSource
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
