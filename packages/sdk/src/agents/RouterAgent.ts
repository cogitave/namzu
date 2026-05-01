import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { collect } from '../provider/collect.js'
import { FallbackResolver } from '../runtime/decision/fallback.js'
import { DecisionParser } from '../runtime/decision/parser.js'
import type {
	AgentInput,
	AgentMetadata,
	RouterAgentConfig,
	RouterAgentResult,
	RoutingDecision,
} from '../types/agent/index.js'
import type { FallbackStrategy } from '../types/decision/index.js'
import { deriveChildState } from '../types/invocation/index.js'
import { createSystemMessage, createUserMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { getRootLogger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'

export class RouterAgent extends AbstractAgent<RouterAgentConfig, RouterAgentResult> {
	readonly type = 'router' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>) {
		super({
			...metadata,
			type: 'router',
			capabilities: {
				supportsTools: false,
				supportsStreaming: true,
				supportsConcurrency: false,
				supportsSubAgents: true,
			},
		})
	}

	async run(
		input: AgentInput,
		config: RouterAgentConfig,
		listener?: RunEventListener,
	): Promise<RouterAgentResult> {
		const startTime = Date.now()
		const runId = this.createRunId()

		await this.emitEvent({ type: 'run_started', runId }, listener)

		const decision = await this.route(input, config)

		let targetRoute = config.routes.find((r) => r.agentId === decision.agentId)

		if (!targetRoute) {
			const fallback = config.fallbackAgentId
				? config.routes.find((r) => r.agentId === config.fallbackAgentId)
				: undefined

			if (!fallback) {
				const errorMsg = `No route found for "${decision.agentId}"`

				await this.emitEvent({ type: 'run_failed', runId, error: errorMsg }, listener)

				return {
					runId,
					status: 'failed',
					stopReason: 'error',
					usage: { ...EMPTY_TOKEN_USAGE },
					cost: { ...ZERO_COST },
					iterations: 1,
					durationMs: Date.now() - startTime,
					messages: input.messages,
					lastError: errorMsg,
					selectedRoute: decision.agentId,
					routingDecision: decision,
					delegateResult: {
						runId,
						status: 'failed',
						usage: { ...EMPTY_TOKEN_USAGE },
						cost: { ...ZERO_COST },
						iterations: 0,
						durationMs: 0,
						messages: [],
					},
				}
			}

			decision.agentId = fallback.agentId
			targetRoute = fallback
		}

		if (!config.invocationState) {
			throw new Error(
				'RouterAgent requires invocationState with tenantId in config (session-hierarchy.md §12.1).',
			)
		}
		const childInvocationState = deriveChildState(config.invocationState, this.metadata.id)
		const delegateResult = await targetRoute.agent.run(
			input,
			{ ...config, invocationState: childInvocationState },
			listener,
		)

		await this.emitEvent(
			{
				type: 'run_completed',
				runId,
				result: delegateResult.result ?? '',
			},
			listener,
		)

		return {
			runId,
			status: delegateResult.status,
			stopReason: delegateResult.stopReason,
			usage: delegateResult.usage,
			cost: delegateResult.cost,
			iterations: delegateResult.iterations + 1,
			durationMs: Date.now() - startTime,
			messages: delegateResult.messages,
			result: delegateResult.result,
			lastError: delegateResult.lastError,
			selectedRoute: decision.agentId,
			routingDecision: decision,
			delegateResult,
		}
	}

	private async route(input: AgentInput, config: RouterAgentConfig): Promise<RoutingDecision> {
		const log = getRootLogger().child({ component: 'RouterAgent', agent: this.metadata.name })

		const validAgentIds = config.routes.map((r) => r.agentId)
		const fallbackAgentId = config.fallbackAgentId ?? config.routes[0]?.agentId ?? ''
		const minConfidence = config.minConfidence ?? 0
		const maxRetries = config.maxRoutingRetries ?? 1

		const parser = new DecisionParser(
			{
				validAgentIds,
				minConfidence,
				maxRetries,
				fallbackAgentId,
			},
			log,
		)

		const fallbackStrategies: FallbackStrategy[] = []

		const patternMap = new Map<string, string[]>()
		for (const route of config.routes) {
			if (route.matchPatterns && route.matchPatterns.length > 0) {
				patternMap.set(route.agentId, route.matchPatterns)
			}
		}
		if (patternMap.size > 0) {
			fallbackStrategies.push({ type: 'pattern_match', patterns: patternMap })
		}

		if (config.fallbackAgentId) {
			fallbackStrategies.push({ type: 'fixed', agentId: config.fallbackAgentId })
		}

		fallbackStrategies.push({ type: 'first_route' })

		const fallbackResolver = new FallbackResolver(fallbackStrategies, log)

		const routeDescriptions = config.routes
			.map((r) => `- ${r.agentId}: ${r.description}`)
			.join('\n')

		const prompt =
			config.routingPrompt ??
			`Given the user's request, select the most appropriate agent.\n\nAvailable agents:\n${routeDescriptions}\n\nRespond with JSON only: { "agentId": "<id>", "confidence": <0-1>, "reasoning": "<why>" }`

		const userContent = input.messages
			.filter((m) => m.role === 'user')
			.map((m) => m.content)
			.filter((c): c is string => c !== null)
			.join('\n')

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await collect(
					config.provider.chatStream({
						model: config.model,
						messages: [createSystemMessage(prompt), createUserMessage(userContent)],
						temperature: 0,
						maxTokens: 200,
					}),
				)

				const parseResult = parser.parse(response.message.content)

				if (parseResult.ok && parseResult.source === 'parsed') {
					return {
						agentId: parseResult.decision.agentId,
						confidence: parseResult.decision.confidence,
						reasoning: parseResult.decision.reasoning,
						routingSource: 'provider',
					}
				}

				if (parseResult.ok && parseResult.source === 'fallback') {
					log.warn(`Routing attempt ${attempt + 1} fell back`, {
						reason: parseResult.reason,
						decision: parseResult.decision,
					})

					if (attempt === maxRetries - 1) {
						return {
							agentId: parseResult.decision.agentId,
							confidence: parseResult.decision.confidence,
							reasoning: parseResult.decision.reasoning,
							routingSource: 'fallback',
						}
					}

					continue
				}

				if (!parseResult.ok) {
					log.warn(`Routing attempt ${attempt + 1} failed to parse`, {
						error: parseResult.error,
					})
					if (attempt === maxRetries - 1) {
						break
					}
				}
			} catch (err) {
				log.warn(`Routing LLM call failed on attempt ${attempt + 1}`, {
					error: String(err),
				})
				if (attempt === maxRetries - 1) {
					break
				}
			}
		}

		return fallbackResolver.resolve(userContent, validAgentIds)
	}
}
