import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { collectChatCompletion } from '../../provider/collect-chat-completion.js'
import { resolveStreamIdleTimeoutMs, withStreamIdleTimeout } from '../../provider/idle-timeout.js'
import { withTokenBudget } from '../../provider/token-budget.js'
import { FallbackResolver } from '../../runtime/decision/fallback.js'
import { DecisionParser } from '../../runtime/decision/parser.js'
import type {
	AgentInput,
	AgentMetadata,
	RouterAgentConfig,
	RouterAgentResult,
	RoutingDecision,
} from '../../types/agent/index.js'
import { type TokenUsage, accumulateTokenUsage } from '../../types/common/index.js'
import type { FallbackStrategy } from '../../types/decision/index.js'
import { deriveChildState } from '../../types/invocation/index.js'
import { createSystemMessage, createUserMessage } from '../../types/message/index.js'
import type { SessionEventListener } from '../../types/session/events.js'
import { ZERO_COST } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import { AbstractAgent } from '../AbstractAgent.js'
import { resolveAgentBudget } from '../budget.js'

/** @deprecated Example of developer-authored routing. */
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
	 * One turn at a time per instance.
	 *
	 * `abortController` and `currentSessionId` are instance state, so two
	 * overlapping turns share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's session, so a later
	 * `cancel()` cancels the wrong children. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: RouterAgentConfig,
		listener?: SessionEventListener,
	): Promise<RouterAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: RouterAgentConfig,
		listener?: SessionEventListener,
	): Promise<RouterAgentResult> {
		// Resolve before a turn id/event exists, matching query(): malformed
		// liveness policy is a caller config error, not a failed model turn.
		const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(config.streamIdleTimeoutMs)
		const signal = input.signal
			? AbortSignal.any([input.signal, this.abortController.signal])
			: this.abortController.signal
		const startTime = Date.now()
		const sessionId = this.resolveSessionId(config.sessionId)
		const turnId = this.createTurnId()
		this.bindTurn(sessionId, turnId, config.logger)
		const budget = await resolveAgentBudget(input, config, { sessionId, turnId })
		const budgetConfig = { ...config, budget }
		// No lifecycle events of its own. A `turn_*` event names a turn in a
		// session log, and routing writes none: the delegate below runs the
		// session's turn and emits its lifecycle, and the listener receives
		// exactly that turn rather than a synthetic one wrapped around it.
		try {
			const decision = await this.route(input, budgetConfig, streamIdleTimeoutMs, signal)

			let targetRoute = config.routes.find((r) => r.agentId === decision.agentId)

			if (!targetRoute) {
				const fallback = config.fallbackAgentId
					? config.routes.find((r) => r.agentId === config.fallbackAgentId)
					: undefined

				if (!fallback) {
					const errorMsg = `No route found for "${decision.agentId}"`

					return {
						sessionId,
						turnId,
						status: 'failed',
						stopReason: 'error',
						usage: budget.ownUsage,
						budget: budget.summary(),
						cost: { ...ZERO_COST, unpricedTokens: budget.ownTokens },
						iterations: 1,
						durationMs: Date.now() - startTime,
						messages: input.messages,
						lastError: errorMsg,
						selectedRoute: decision.agentId,
						routingDecision: decision,
						delegateResult: {
							sessionId,
							turnId,
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
			const allocation = Number.isFinite(budget.remaining)
				? Math.floor(budget.remaining)
				: config.tokenBudget || 200_000
			const childBudget = budget.reserve(allocation)
			await childBudget.flush()
			let delegateResult: RouterAgentResult['delegateResult']
			try {
				delegateResult = await targetRoute.agent.run(
					input,
					{
						...config,
						budget: childBudget,
						tokenBudget: allocation,
						// The same session: the delegate runs this session's turn,
						// it is not a child session of it.
						sessionId,
						depth: (config.depth ?? 0) + 1,
						invocationState: childInvocationState,
					},
					listener,
				)
				childBudget.bindTurn(delegateResult.sessionId, delegateResult.turnId)
				childBudget.settle(delegateResult.usage.totalTokens)
			} finally {
				// A thrown custom delegate supplies no final usage receipt.
				// Its reservation stays held until an authoritative settlement.
				await childBudget.flush()
			}

			return {
				sessionId,
				turnId: delegateResult.turnId,
				status: delegateResult.status,
				stopReason: delegateResult.stopReason,
				usage: budget.ownUsage,
				budget: budget.summary(),
				cost: { ...ZERO_COST, unpricedTokens: budget.ownTokens },
				iterations: delegateResult.iterations + 1,
				durationMs: Date.now() - startTime,
				messages: delegateResult.messages,
				result: delegateResult.result,
				lastError: delegateResult.lastError,
				selectedRoute: decision.agentId,
				routingDecision: decision,
				delegateResult,
			}
		} finally {
			budget.settle()
			await budget.flush()
		}
	}

	private async route(
		input: AgentInput,
		config: RouterAgentConfig,
		streamIdleTimeoutMs: number,
		signal: AbortSignal,
	): Promise<RoutingDecision> {
		// `this.log`, not a fresh `getRootLogger()` child — bound by `bindTurn`
		// in `runExclusive` before this is called, so a routing warning below
		// carries the SAME `namzu.turn.id` as the turn it is routing. The old
		// independent construction here is the exact bug LOG-10's acceptance
		// criterion names: a route() log line with no id at all.
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
			fallbackStrategies.push({
				type: 'fixed',
				agentId: config.fallbackAgentId,
			})
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
		const routingProvider = withStreamIdleTimeout(
			config.budget ? withTokenBudget(config.provider, config.budget) : config.provider,
			{
				idleTimeoutMs: streamIdleTimeoutMs,
				log,
			},
		)

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await collectChatCompletion(
					routingProvider.chatStream({
						model: config.model,
						messages: [createSystemMessage(prompt), createUserMessage(userContent)],
						temperature: 0,
						maxTokens: 200,
						signal,
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
				// Provider-idle expiry aborts only the wrapper's private transport
				// and is eligible for the router's declared fallback. A caller or
				// agent cancellation owns this fused signal and must not be
				// reinterpreted as permission to start a delegate.
				if (signal.aborted) throw signal.reason
				log.warn('Routing LLM call failed', {
					'namzu.router.attempt': attempt + 1,
					'exception.message': String(err),
				})
				if (attempt === maxRetries - 1) {
					break
				}
			}
		}

		return {
			...fallbackResolver.resolve(userContent, validAgentIds),
			usage: routingUsage,
		}
	}
}
