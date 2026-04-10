import { z } from 'zod'
import { MAX_CUSTOM_PATTERN_LENGTH } from '../../constants/verification/index.js'

export type GateDecision = 'allow' | 'deny' | 'review'

export interface GateEvaluationResult {
	readonly decision: GateDecision
	readonly matchedRule: VerificationRule | null
	readonly reason: string
}

export type VerificationRule =
	| { type: 'allow_read_only' }
	| { type: 'deny_dangerous_patterns' }
	| { type: 'allow_by_category'; categories: string[] }
	| { type: 'allow_by_name'; toolNames: string[] }
	| { type: 'deny_by_name'; toolNames: string[] }
	| {
			type: 'custom_pattern'
			pattern: string
			target: 'name' | 'args' | 'both'
			decision: 'allow' | 'deny'
	  }
	| { type: 'allow_by_tier'; tiers: string[] }

const AllowReadOnlySchema = z.object({ type: z.literal('allow_read_only') })
const DenyDangerousPatternsSchema = z.object({ type: z.literal('deny_dangerous_patterns') })
const AllowByCategorySchema = z.object({
	type: z.literal('allow_by_category'),
	categories: z.array(z.string()),
})
const AllowByNameSchema = z.object({
	type: z.literal('allow_by_name'),
	toolNames: z.array(z.string()),
})
const DenyByNameSchema = z.object({
	type: z.literal('deny_by_name'),
	toolNames: z.array(z.string()),
})
const CustomPatternSchema = z.object({
	type: z.literal('custom_pattern'),
	pattern: z.string().max(MAX_CUSTOM_PATTERN_LENGTH),
	target: z.enum(['name', 'args', 'both']),
	decision: z.enum(['allow', 'deny']),
})
const AllowByTierSchema = z.object({
	type: z.literal('allow_by_tier'),
	tiers: z.array(z.string()),
})

export const VerificationRuleSchema = z.discriminatedUnion('type', [
	AllowReadOnlySchema,
	DenyDangerousPatternsSchema,
	AllowByCategorySchema,
	AllowByNameSchema,
	DenyByNameSchema,
	CustomPatternSchema,
	AllowByTierSchema,
])

export const VerificationGateConfigSchema = z.object({
	enabled: z.boolean().default(false),
	rules: z.array(VerificationRuleSchema).default([]),
	allowReadOnlyTools: z.boolean().default(false),
	denyDangerousPatterns: z.boolean().default(false),
	logDecisions: z.boolean().default(true),
})

export type VerificationGateConfig = z.infer<typeof VerificationGateConfigSchema>
