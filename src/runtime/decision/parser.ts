import {
	type DecisionParseResult,
	type DecisionParserConfig,
	RoutingResponseSchema,
} from '../../types/decision/index.js'
import type { Logger } from '../../utils/logger.js'

export class DecisionParser {
	private config: DecisionParserConfig
	private log: Logger

	constructor(config: DecisionParserConfig, log: Logger) {
		this.config = config
		this.log = log
	}

	parse(rawContent: string | null): DecisionParseResult {
		if (!rawContent || rawContent.trim().length === 0) {
			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: 0,
					reasoning: 'Empty LLM response',
				},
				source: 'fallback',
				reason: 'empty_response',
			}
		}

		const jsonStr = this.extractJson(rawContent)
		if (!jsonStr) {
			this.log.warn('Failed to extract JSON from LLM routing response', {
				contentPreview: rawContent.slice(0, 200),
			})
			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: 0,
					reasoning: 'Could not extract JSON from response',
				},
				source: 'fallback',
				reason: 'json_extraction_failed',
			}
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(jsonStr)
		} catch (err) {
			this.log.warn('Invalid JSON in routing response', {
				error: String(err),
				contentPreview: jsonStr.slice(0, 200),
			})
			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: 0,
					reasoning: `JSON parse failed: ${String(err)}`,
				},
				source: 'fallback',
				reason: 'json_parse_failed',
			}
		}

		const validation = RoutingResponseSchema.safeParse(parsed)
		if (!validation.success) {
			const errors = validation.error.issues
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ')

			this.log.warn('Routing response failed schema validation', { errors })

			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: 0,
					reasoning: `Schema validation failed: ${errors}`,
				},
				source: 'fallback',
				reason: 'schema_validation_failed',
			}
		}

		const response = validation.data

		if (!this.config.validAgentIds.includes(response.agentId)) {
			this.log.warn('LLM returned unknown agentId', {
				agentId: response.agentId,
				validIds: this.config.validAgentIds,
			})

			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: 0,
					reasoning: `Unknown agentId "${response.agentId}", falling back`,
				},
				source: 'fallback',
				reason: 'unknown_agent_id',
			}
		}

		if (response.confidence < this.config.minConfidence) {
			this.log.info('Routing confidence below threshold', {
				confidence: response.confidence,
				threshold: this.config.minConfidence,
				agentId: response.agentId,
			})

			return {
				ok: true,
				decision: {
					agentId: this.config.fallbackAgentId,
					confidence: response.confidence,
					reasoning: `Confidence ${response.confidence} below threshold ${this.config.minConfidence}`,
				},
				source: 'fallback',
				reason: 'low_confidence',
			}
		}

		return {
			ok: true,
			decision: response,
			source: 'parsed',
		}
	}

	private extractJson(content: string): string | null {
		const trimmed = content.trim()

		if (trimmed.startsWith('{')) {
			return trimmed
		}

		const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
		if (codeBlockMatch?.[1]) {
			return codeBlockMatch[1].trim()
		}

		const braceStart = trimmed.indexOf('{')
		const braceEnd = trimmed.lastIndexOf('}')
		if (braceStart !== -1 && braceEnd > braceStart) {
			return trimmed.slice(braceStart, braceEnd + 1)
		}

		return null
	}
}
