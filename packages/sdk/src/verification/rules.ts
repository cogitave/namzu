import { DANGEROUS_PATTERNS } from '../constants/tools/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import type { GateDecision, VerificationRule } from '../types/verification/index.js'

export function evaluateRule(
	rule: VerificationRule,
	toolName: string,
	toolInput: unknown,
	toolDef: ToolDefinition | undefined,
	compiledPattern?: RegExp,
	nameSet?: Set<string>,
): GateDecision | null {
	switch (rule.type) {
		case 'allow_read_only': {
			return toolDef?.isReadOnly?.(toolInput) ? 'allow' : null
		}

		case 'deny_dangerous_patterns': {
			const serialized = JSON.stringify(toolInput)
			for (const pattern of DANGEROUS_PATTERNS) {
				if (pattern.test(serialized)) {
					return 'deny'
				}
			}
			return null
		}

		case 'allow_by_category': {
			if (toolDef?.category && rule.categories.includes(toolDef.category)) {
				return 'allow'
			}
			return null
		}

		case 'allow_by_name': {
			return nameSet?.has(toolName) ? 'allow' : null
		}

		case 'deny_by_name': {
			return nameSet?.has(toolName) ? 'deny' : null
		}

		case 'custom_pattern': {
			if (!compiledPattern) return null

			let target: string
			switch (rule.target) {
				case 'name':
					target = toolName
					break
				case 'args':
					target = JSON.stringify(toolInput)
					break
				case 'both':
					target = `${toolName} ${JSON.stringify(toolInput)}`
					break
				default: {
					const _exhaustive: never = rule.target
					throw new Error(`Unhandled custom_pattern target: ${_exhaustive as string}`)
				}
			}

			return compiledPattern.test(target) ? rule.decision : null
		}

		case 'allow_by_tier': {
			if (toolDef?.tier && rule.tiers.includes(toolDef.tier)) {
				return 'allow'
			}
			return null
		}

		default: {
			const _exhaustive: never = rule
			throw new Error(`Unhandled verification rule type: ${(_exhaustive as { type: string }).type}`)
		}
	}
}
