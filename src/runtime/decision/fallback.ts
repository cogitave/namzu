import type { RoutingDecision } from '../../types/agent/router.js'
import type { FallbackStrategy } from '../../types/decision/index.js'
import type { Logger } from '../../utils/logger.js'

export class FallbackResolver {
	private strategies: FallbackStrategy[]
	private log: Logger

	constructor(strategies: FallbackStrategy[], log: Logger) {
		this.strategies = strategies
		this.log = log
	}

	resolve(userContent: string, validAgentIds: string[]): RoutingDecision {
		for (const strategy of this.strategies) {
			switch (strategy.type) {
				case 'pattern_match': {
					const match = this.matchPatterns(userContent, strategy.patterns)
					if (match && validAgentIds.includes(match)) {
						this.log.info('Fallback resolved via pattern match', { agentId: match })
						return {
							agentId: match,
							confidence: 0.5,
							reasoning: `Pattern match fallback: matched "${match}"`,
							routingSource: 'fallback',
						}
					}
					break
				}
				case 'fixed': {
					if (validAgentIds.includes(strategy.agentId)) {
						this.log.info('Fallback resolved via fixed strategy', { agentId: strategy.agentId })
						return {
							agentId: strategy.agentId,
							confidence: 0,
							reasoning: 'Fixed fallback strategy',
							routingSource: 'fallback',
						}
					}
					break
				}
				case 'first_route': {
					if (validAgentIds.length > 0) {
						const first = validAgentIds[0]!
						this.log.info('Fallback resolved via first_route strategy', { agentId: first })
						return {
							agentId: first,
							confidence: 0,
							reasoning: 'First route fallback strategy',
							routingSource: 'fallback',
						}
					}
					break
				}
				default: {
					const _exhaustive: never = strategy
					throw new Error(`Unhandled fallback strategy: ${(_exhaustive as FallbackStrategy).type}`)
				}
			}
		}

		this.log.error('All fallback strategies exhausted')
		return {
			agentId: validAgentIds[0] ?? '',
			confidence: 0,
			reasoning: 'All fallback strategies exhausted',
			routingSource: 'hard_fail',
		}
	}

	private matchPatterns(userContent: string, patterns: Map<string, string[]>): string | null {
		const lower = userContent.toLowerCase()
		let bestMatch: { agentId: string; score: number } | null = null

		for (const [agentId, keywords] of patterns) {
			let score = 0
			for (const keyword of keywords) {
				if (lower.includes(keyword.toLowerCase())) {
					score++
				}
			}

			if (score > 0 && (!bestMatch || score > bestMatch.score)) {
				bestMatch = { agentId, score }
			}
		}

		return bestMatch?.agentId ?? null
	}
}
