import { MAX_CUSTOM_PATTERN_LENGTH } from '../constants/verification/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import type {
	GateEvaluationResult,
	VerificationGateConfig,
	VerificationRule,
} from '../types/verification/index.js'
import { VerificationGateConfigSchema } from '../types/verification/index.js'
import type { Logger } from '../utils/logger.js'
import { evaluateRule } from './rules.js'

export interface ToolCallContext {
	readonly toolName: string
	readonly toolInput: unknown
	readonly toolDef: ToolDefinition | undefined
}

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

	evaluate(ctx: ToolCallContext): GateEvaluationResult {
		if (!this.enabled) {
			return {
				decision: 'review',
				matchedRule: null,
				reason: 'Gate disabled',
			}
		}

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

			if (decision !== null) {
				const result: GateEvaluationResult = {
					decision,
					matchedRule: rule,
					reason: `Matched rule: ${rule.type}`,
				}

				if (this.logDecisions) {
					this.log.debug('Gate decision', {
						toolName: ctx.toolName,
						decision,
						ruleType: rule.type,
						ruleIndex: i,
					})
				}

				return result
			}
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
}
