import { z } from 'zod'
import { MAX_CUSTOM_PATTERN_LENGTH } from '../../constants/authorization/index.js'

export type GateDecision = 'allow' | 'deny' | 'review'

export interface GateEvaluationResult {
	readonly decision: GateDecision
	readonly matchedRule: AuthorizationRule | null
	readonly reason: string
}

export type AuthorizationRule =
	| { type: 'allow_read_only' }
	| { type: 'deny_dangerous_patterns' }
	| { type: 'allow_by_category'; categories: string[] }
	| { type: 'allow_by_name'; toolNames: string[] }
	| { type: 'deny_by_name'; toolNames: string[] }
	| {
			/**
			 * Match a regular expression against the tool's NAME, the
			 * serialised arguments, or both concatenated.
			 *
			 * Read `target: 'args'` carefully before writing one: it tests
			 * `JSON.stringify(toolInput)`, so the subject is the JSON TEXT of
			 * the whole argument object — `{"command":"git push origin main"}`
			 * — and not any single argument. The name suggests otherwise, and
			 * that is what makes it a trap: an anchored pattern like
			 * `^git push.*$` is a natural thing to write and can never match,
			 * so the rule silently decides nothing. `'both'` PREFIXES the tool
			 * name to that text rather than requiring it, so it is not a scope
			 * either — a rule written with `bash` in mind still sees every
			 * other tool's arguments.
			 *
			 * When you mean "this tool, this argument", use
			 * {@link AuthorizationRule} `argument_pattern` instead. This one
			 * stays for the case it is actually good at: matching anywhere in
			 * the serialised input without caring where.
			 */
			type: 'custom_pattern'
			pattern: string
			target: 'name' | 'args' | 'both'
			decision: 'allow' | 'deny'
	  }
	| {
			/**
			 * Match a regular expression against ONE named argument of ONE
			 * named set of tools.
			 *
			 * This exists because `custom_pattern` could express neither half.
			 * It carries no tool scope, so a rule an operator wrote about
			 * `bash` decided `edit` calls too; and its argument target tests
			 * the serialised object, so pinning the tool cost the ability to
			 * anchor and anchoring cost the tool scope. Every pattern rule was
			 * therefore one of those two wrong things.
			 *
			 * The subject here is the argument's own VALUE, so `^git push`
			 * means what it looks like it means.
			 *
			 * A rule whose tool is not called, or whose argument is absent,
			 * decides nothing — the rule's precondition simply is not met. So
			 * does one whose argument holds an object or an array: a pattern
			 * cannot say anything true about a structured value, and pretending
			 * otherwise by matching its serialisation would reintroduce exactly
			 * the confusion this rule was added to remove. If you need to
			 * refuse a tool over the SHAPE of its input rather than a string in
			 * it, deny it by name.
			 */
			type: 'argument_pattern'
			toolNames: string[]
			/** The argument key, at the top level of the tool's input. */
			argument: string
			pattern: string
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
const ArgumentPatternSchema = z.object({
	type: z.literal('argument_pattern'),
	toolNames: z.array(z.string()).min(1),
	// A rule that names no argument would silently apply to none, which is the
	// fail-open shape this rule type exists to remove.
	argument: z.string().min(1),
	pattern: z.string().max(MAX_CUSTOM_PATTERN_LENGTH),
	decision: z.enum(['allow', 'deny']),
})
const AllowByTierSchema = z.object({
	type: z.literal('allow_by_tier'),
	tiers: z.array(z.string()),
})

export const AuthorizationRuleSchema = z.discriminatedUnion('type', [
	AllowReadOnlySchema,
	DenyDangerousPatternsSchema,
	AllowByCategorySchema,
	AllowByNameSchema,
	DenyByNameSchema,
	CustomPatternSchema,
	ArgumentPatternSchema,
	AllowByTierSchema,
])

export const AuthorizationGateConfigSchema = z.object({
	enabled: z.boolean().default(false),
	rules: z.array(AuthorizationRuleSchema).default([]),
	allowReadOnlyTools: z.boolean().default(false),
	denyDangerousPatterns: z.boolean().default(false),
	logDecisions: z.boolean().default(true),
})

export type AuthorizationGateConfig = z.infer<typeof AuthorizationGateConfigSchema>

/**
 * Old spellings, live for one deprecation window.
 *
 * A reader who saw `VerificationGate` expected something that verifies a
 * claim — checks a signature, confirms an output matches a schema. This is
 * a rule engine that decides, BEFORE a tool runs, whether the call is
 * permitted: allow / deny / review, by name, category, tier or a pattern
 * over the arguments. Every rule variant says so.
 *
 * The misreading was not academic. The module sat beside real guardrail and
 * HITL neighbours, where "verification" actively suggests the post-hoc
 * double-check the guardrails do.
 */

/**
 * The two schemas below carry aliases too, and the task that specified this
 * rename said they would not need any: `public-runtime.ts` records that they
 * are deliberately not re-exported, so they looked unreachable.
 *
 * They were not. `public-types.ts` re-exports this module with
 * `export type *`, which exports every name in TYPE position — including a
 * `const`. So `import type { VerificationRuleSchema } from '@namzu/sdk'`
 * compiled and `typeof VerificationRuleSchema` was a usable type, while
 * importing it as a value failed with TS1362. Checked by compiling both
 * forms against the built package rather than reading the barrel.
 *
 * Declared as `const` rather than `type` on purpose: a `type` alias would
 * break `typeof`, which is the only way these were ever usable.
 */

/** @deprecated Renamed to {@link AuthorizationRuleSchema}. Removed in the next major. */
export const VerificationRuleSchema = AuthorizationRuleSchema
/** @deprecated Renamed to {@link AuthorizationGateConfigSchema}. Removed in the next major. */
export const VerificationGateConfigSchema = AuthorizationGateConfigSchema

/** @deprecated Renamed to {@link AuthorizationRule}. Removed in the next major. */
export type VerificationRule = AuthorizationRule
/** @deprecated Renamed to {@link AuthorizationGateConfig}. Removed in the next major. */
export type VerificationGateConfig = AuthorizationGateConfig
