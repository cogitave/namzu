import { MAX_CUSTOM_PATTERN_LENGTH } from '../constants/authorization/index.js'
import { GENAI } from '../constants/telemetry/index.js'
import type {
	AuthorizationGateConfig,
	AuthorizationRule,
	GateEvaluationResult,
} from '../types/authorization/index.js'
import { AuthorizationGateConfigSchema } from '../types/authorization/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import type { Logger } from '../utils/logger.js'
import { evaluateRule } from './rules.js'

export interface ToolCallContext {
	readonly toolName: string
	readonly toolInput: unknown
	readonly toolDef: ToolDefinition | undefined
}

/**
 * What the rule actually said, in words a model can act on.
 *
 * This used to be the rule TYPE and nothing else, so a denial reached the
 * model as "Blocked by the verification gate: Matched rule: deny_by_name" —
 * naming the kind of rule and nothing about it. Not which tool, not which
 * pattern, not whether a different input would fare better.
 *
 * The difference is behavioural rather than cosmetic. Told only that it was
 * denied, a model rewords the same call and tries again, because nothing in
 * the message says a retry is pointless. Told that a pattern rule denies
 * `git push*`, it can stop, say so, and do something else. A refusal that
 * cannot be reasoned about produces thrashing; one that can produces a route
 * around it.
 */
export function describeRule(rule: AuthorizationRule): string {
	switch (rule.type) {
		case 'deny_dangerous_patterns':
			return 'this matches a pattern the operator refuses outright; rewording it will not help'
		case 'allow_read_only':
			return 'allowed because this tool only observes'
		case 'allow_by_name':
			return `allowed by name (${rule.toolNames.join(', ')})`
		case 'deny_by_name':
			return `denied by name (${rule.toolNames.join(', ')}) — this tool is refused for this run, so a different input will not change it`
		case 'allow_by_category':
			return `allowed by category (${rule.categories.join(', ')})`
		case 'allow_by_tier':
			return `allowed by tier (${rule.tiers.join(', ')})`
		case 'argument_pattern': {
			// Names the argument, not just the pattern. That is what tells a
			// model whether a different value could get through — which is the
			// difference between rewording once and rewording forever.
			const verb = rule.decision === 'deny' ? 'denied' : 'allowed'
			return `${verb} because the \`${rule.argument}\` argument matched ${rule.pattern} (this rule applies to ${rule.toolNames.join(', ')})`
		}

		case 'custom_pattern': {
			const where = rule.target === 'both' ? 'name or arguments' : rule.target
			const verb = rule.decision === 'deny' ? 'denied' : 'allowed'
			return `${verb} by a pattern rule matching the ${where}: ${rule.pattern}`
		}
		default: {
			const exhaustive: never = rule
			return `matched an unrecognised rule: ${JSON.stringify(exhaustive)}`
		}
	}
}

export class AuthorizationGate {
	private readonly rules: AuthorizationRule[]
	private readonly compiledPatterns: Map<number, RegExp>
	private readonly nameSets: Map<number, Set<string>>
	private readonly log: Logger
	private readonly logDecisions: boolean
	private readonly enabled: boolean

	constructor(config: AuthorizationGateConfig, log: Logger) {
		const parsed = AuthorizationGateConfigSchema.parse(config)
		this.log = log.child({ [SCOPE_ATTRIBUTE]: 'authorization/gate' })
		this.logDecisions = parsed.logDecisions
		this.enabled = parsed.enabled

		const expandedRules: AuthorizationRule[] = []

		// Order is the whole meaning of this list, because the first rule to
		// match decides and nothing after it is consulted.
		//
		// The dangerous-pattern denial goes FIRST and stays there: it is the
		// floor, and an operator rule must not be able to open what it closes.
		//
		// The read-only allowance goes LAST, and it used to go second — ahead of
		// the operator's own rules. With first-match-wins that made a rule like
		// "prompt me before every read" UNREACHABLE while allowReadOnlyTools was
		// on: not rejected, not warned about, just never consulted. Someone who
		// writes a rule and is silently ignored gets the worst outcome available
		// — they believe a control is in force and it is not.
		//
		// So it becomes what it always was in substance: a DEFAULT for tools
		// nobody wrote a rule about, rather than an override of the rules they
		// did write. The denial above still outranks both.
		if (parsed.denyDangerousPatterns) {
			expandedRules.push({ type: 'deny_dangerous_patterns' })
		}

		expandedRules.push(...parsed.rules)

		if (parsed.allowReadOnlyTools) {
			expandedRules.push({
				type: 'allow_read_only',
				...(parsed.allowReadOnlyExcludeCategories
					? { excludeCategories: parsed.allowReadOnlyExcludeCategories }
					: {}),
			})
		}
		this.rules = expandedRules

		this.compiledPatterns = new Map()
		this.nameSets = new Map()

		for (let i = 0; i < this.rules.length; i++) {
			const rule = this.rules[i]
			if (!rule) continue

			if (rule.type === 'custom_pattern') {
				if (rule.pattern.length > MAX_CUSTOM_PATTERN_LENGTH) {
					this.log.warn('Custom pattern exceeds max length, skipping', {
						'namzu.authorization.index': i,
						'namzu.authorization.length': rule.pattern.length,
						'namzu.authorization.max_length': MAX_CUSTOM_PATTERN_LENGTH,
					})
					continue
				}
				try {
					this.compiledPatterns.set(i, new RegExp(rule.pattern))
				} catch (err) {
					this.log.warn('Invalid custom pattern regex, skipping', {
						'namzu.authorization.index': i,
						'namzu.authorization.pattern': rule.pattern,
						'exception.message': err instanceof Error ? err.message : String(err),
					})
				}
			}

			if (rule.type === 'argument_pattern') {
				// Needs BOTH, because it is the rule that names both.
				//
				// The name set is recorded only after the pattern compiles, so
				// a rule with a typo'd regex leaves neither half behind. That
				// ordering is defence in depth and NOT what makes the guarantee
				// — `evaluateRule` returns null on a missing compiled pattern
				// before it ever looks at the name set, so reversing these two
				// lines changes no behaviour. Measured: reversing them fails no
				// test, and the test that looks like it covers this is really
				// covering the check in `evaluateRule`.
				//
				// Written down because the alternative is someone later reading
				// the order as load-bearing and preserving it for the wrong
				// reason, or removing the real check believing this one covers
				// it.
				if (rule.pattern.length > MAX_CUSTOM_PATTERN_LENGTH) {
					this.log.warn('Argument pattern exceeds max length, skipping', {
						'namzu.authorization.index': i,
						'namzu.authorization.length': rule.pattern.length,
						'namzu.authorization.max_length': MAX_CUSTOM_PATTERN_LENGTH,
					})
					continue
				}
				try {
					const compiled = new RegExp(rule.pattern)
					this.compiledPatterns.set(i, compiled)
					this.nameSets.set(i, new Set(rule.toolNames))
				} catch (err) {
					this.log.warn('Invalid argument pattern regex, skipping', {
						'namzu.authorization.index': i,
						'namzu.authorization.pattern': rule.pattern,
						'exception.message': err instanceof Error ? err.message : String(err),
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
					reason: describeRule(rule),
				}

				if (this.logDecisions) {
					this.log.debug('Gate decision', {
						[GENAI.TOOL_NAME]: ctx.toolName,
						'namzu.authorization.decision': decision,
						'namzu.authorization.rule_type': rule.type,
						'namzu.authorization.rule_index': i,
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
				[GENAI.TOOL_NAME]: ctx.toolName,
				'namzu.authorization.decision': 'review',
			})
		}

		return result
	}
}
