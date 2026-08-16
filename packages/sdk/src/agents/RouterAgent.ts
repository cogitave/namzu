import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { collectChatCompletion } from '../provider/collect-chat-completion.js'
import { FallbackResolver } from '../runtime/decision/fallback.js'
import { DecisionParser } from '../runtime/decision/parser.js'
import type {
	AgentInput,
	AgentMetadata,
	RouterAgentConfig,
	RouterAgentResult,
	RoutingDecision,
} from '../types/agent/index.js'
import { type TokenUsage, accumulateTokenUsage } from '../types/common/index.js'
import type { FallbackStrategy } from '../types/decision/index.js'
import { deriveChildState } from '../types/invocation/index.js'
import { createSystemMessage, createUserMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import type { Logger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'

export class RouterAgent extends AbstractAgent<RouterAgentConfig, RouterAgentResult> {
	readonly type = 'router' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super(
			{
				...metadata,
				type: 'router',
				capabilities: {
					supportsTools: false,
					supportsStreaming: true,
					supportsConcurrency: false,
					supportsSubAgents: true,
				},
			},
			log,
		)
	}

	/**
	 * One run at a time per instance.
	 *
	 * `abortController` and `currentRunId` are instance state, so two
	 * overlapping runs share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's run id, so a later
	 * `cancel()` cancels the wrong run. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: RouterAgentConfig,
		listener?: RunEventListener,
	): Promise<RouterAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: RouterAgentConfig,
		listener?: RunEventListener,
	): Promise<RouterAgentResult> {
		const startTime = Date.now()
		const runId = this.createRunId()
		this.bindRun(runId, config.logger)

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
			// Routing is a model call the run paid for; reporting only the
			// delegate's usage silently under-reports every routed run.
			usage: accumulateTokenUsage(delegateResult.usage, decision.usage ?? EMPTY_TOKEN_USAGE),
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
		// `this.log`, not a fresh `getRootLogger()` child — bound by `bindRun` in
		// `runExclusive` before this is called, so a routing warning below
		// carries the SAME `namzu.run.id` as the run it is routing. The old
		// independent construction here is the exact bug LOG-10's acceptance
		// criterion names: a route() log line with no run id at all.
		const log = this.log

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

		// Every routing attempt is a billed model call; a fallback after
		// three failed parses still cost three calls.
		let routingUsage: TokenUsage = { ...EMPTY_TOKEN_USAGE }

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await collectChatCompletion(
					config.provider.chatStream({
						model: config.model,
						messages: [createSystemMessage(prompt), createUserMessage(userContent)],
						temperature: 0,
						maxTokens: 200,
					}),
				)

				routingUsage = accumulateTokenUsage(routingUsage, response.usage)

				const parseResult = parser.parse(response.message.content)

				if (parseResult.ok && parseResult.source === 'parsed') {
					return {
						agentId: parseResult.decision.agentId,
						confidence: parseResult.decision.confidence,
						reasoning: parseResult.decision.reasoning,
						routingSource: 'provider',
						usage: routingUsage,
					}
				}

				if (parseResult.ok && parseResult.source === 'fallback') {
					log.warn('Routing attempt fell back', {
						'namzu.router.attempt': attempt + 1,
						'namzu.agents.reason': parseResult.reason,
						'namzu.agents.decision': parseResult.decision,
					})

					if (attempt === maxRetries - 1) {
						return {
							agentId: parseResult.decision.agentId,
							confidence: parseResult.decision.confidence,
							reasoning: parseResult.decision.reasoning,
							routingSource: 'fallback',
							usage: routingUsage,
						}
					}

					continue
				}

				if (!parseResult.ok) {
					log.warn('Routing attempt failed to parse', {
						'namzu.router.attempt': attempt + 1,
						'exception.message': parseResult.error,
					})
					if (attempt === maxRetries - 1) {
						break
					}
				}
			} catch (err) {
				log.warn('Routing LLM call failed', {
					'namzu.router.attempt': attempt + 1,
					'exception.message': String(err),
				})
				if (attempt === maxRetries - 1) {
					break
				}
			}
		}

		return { ...fallbackResolver.resolve(userContent, validAgentIds), usage: routingUsage }
	}
}
