import { z } from 'zod'

export const RoutingResponseSchema = z
	.object({
		agentId: z.string().min(1, 'agentId is required'),
		confidence: z.number().min(0).max(1),
		reasoning: z.string().optional(),
	})
	.strict()

export type RoutingResponse = z.infer<typeof RoutingResponseSchema>

export interface DecisionParserConfig {
	validAgentIds: string[]

	minConfidence: number

	maxRetries: number

	fallbackAgentId: string
}

export type DecisionParseResult =
	| { ok: true; decision: RoutingResponse; source: 'parsed' }
	| { ok: true; decision: RoutingResponse; source: 'pattern_match' }
	| { ok: true; decision: RoutingResponse; source: 'fallback'; reason: string }
	| { ok: false; error: string; rawContent: string }

export type FallbackStrategy =
	| { type: 'fixed'; agentId: string }
	| { type: 'pattern_match'; patterns: Map<string, string[]> }
	| { type: 'first_route' }
