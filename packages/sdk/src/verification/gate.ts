import { MAX_CUSTOM_PATTERN_LENGTH } from '../constants/verification/index.js'
import type {
	GateDecision,
	GateEvaluationResult,
	ToolCallContext,
	VerificationGateConfig,
	VerificationRule,
} from '../types/verification/index.js'
import { VerificationGateConfigSchema } from '../types/verification/index.js'
import type { Logger } from '../utils/logger.js'
import { evaluateRule } from './rules.js'

export type { ToolCallContext }

export class VerificationGate {
	private readonly rules: VerificationRule[]
	private readonly compiledPatterns: Map<number, RegExp>
	private readonly nameSets: Map<number, Set<string>>
	private readonly log: Logger
	private readonly logDecisions: boolean
	private readonly enabled: boolean

	constructor(config: VerificationGateConfig, log: Logger) {
		const parsed = VerificationGateConfigSchema.parse(config)
		this.log = log.child({ component: 'VerificationGate' })
		this.logDecisions = parsed.logDecisions
		this.enabled = parsed.enabled

		const expandedRules: VerificationRule[] = []

		if (parsed.denyDangerousPatterns) {
			expandedRules.push({ type: 'deny_dangerous_patterns' })
		}
		if (parsed.allowReadOnlyTools) {
			expandedRules.push({ type: 'allow_read_only' })
		}

		expandedRules.push(...parsed.rules)
		this.rules = expandedRules

		this.compiledPatterns = new Map()
		this.nameSets = new Map()

		for (let i = 0; i < this.rules.length; i++) {
			const rule = this.rules[i]
			if (!rule) continue

			if (rule.type === 'custom_pattern') {
				if (rule.pattern.length > MAX_CUSTOM_PATTERN_LENGTH) {
					this.log.warn('Custom pattern exceeds max length, skipping', {
						index: i,
						length: rule.pattern.length,
						maxLength: MAX_CUSTOM_PATTERN_LENGTH,
					})
					continue
				}
				try {
					this.compiledPatterns.set(i, new RegExp(rule.pattern))
				} catch (err) {
					this.log.warn('Invalid custom pattern regex, skipping', {
						index: i,
						pattern: rule.pattern,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (rule.type === 'allow_by_name') {
				this.nameSets.set(i, new Set(rule.toolNames))
			}
			if (rule.type === 'deny_by_name') {
				this.nameSets.set(i, new Set(rule.toolNames))
			}
		}
	}

	/**
	 * Deny is a plane, not a position in a list.
	 *
	 * Rule order decides allow-vs-review and nothing else: a deny rule matching
	 * this call wins over an allow rule matching the same call no matter which
	 * one is written first. Under the old first-match-wins scan, an earlier
	 * `allow` masked a later `deny` — and since the constructor prepends the
	 * built-in `allow_read_only` rule ahead of every operator-authored rule, an
	 * operator's explicit `deny_by_name` on a read-only tool was dead config.
	 * Deny short-circuits; an allow match is remembered but keeps scanning, so a
	 * deny further down still overrides it.
	 */
	evaluate(ctx: ToolCallContext): GateEvaluationResult {
		if (!this.enabled) {
			return {
				decision: 'review',
				matchedRule: null,
				reason: 'Gate disabled',
			}
		}

		let firstAllowOrReview: {
			rule: VerificationRule
			index: number
			decision: GateDecision
		} | null = null

		for (let i = 0; i < this.rules.length; i++) {
			const rule = this.rules[i]
			if (!rule) continue
			const decision = evaluateRule(
				rule,
				ctx.toolName,
				ctx.toolInput,
				ctx.toolDef,
				this.compiledPatterns.get(i),
				this.nameSets.get(i),
			)

			if (decision === null) continue

			if (decision === 'deny') {
				return this.decided(ctx, decision, rule, i)
			}

			firstAllowOrReview ??= { rule, index: i, decision }
		}

		if (firstAllowOrReview) {
			return this.decided(
				ctx,
				firstAllowOrReview.decision,
				firstAllowOrReview.rule,
				firstAllowOrReview.index,
			)
		}

		const result: GateEvaluationResult = {
			decision: 'review',
			matchedRule: null,
			reason: 'No matching rule found',
		}

		if (this.logDecisions) {
			this.log.debug('Gate decision (default)', {
				toolName: ctx.toolName,
				decision: 'review',
			})
		}

		return result
	}

	private decided(
		ctx: ToolCallContext,
		decision: GateDecision,
		rule: VerificationRule,
		index: number,
	): GateEvaluationResult {
		if (this.logDecisions) {
			this.log.debug('Gate decision', {
				toolName: ctx.toolName,
				decision,
				ruleType: rule.type,
				ruleIndex: index,
			})
		}

		return {
			decision,
			matchedRule: rule,
			reason: `Matched rule: ${rule.type}`,
		}
	}
}
