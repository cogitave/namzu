import { DANGEROUS_PATTERNS } from '../constants/tools/index.js'
import { isTrustedReadOnly } from '../tools/trusted-read-only.js'
import type { AuthorizationRule, GateDecision } from '../types/authorization/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { decomposeCommandLine } from './command-line.js'

export function evaluateRule(
	rule: AuthorizationRule,
	toolName: string,
	toolInput: unknown,
	toolDef: ToolDefinition | undefined,
	compiledPattern?: RegExp,
	nameSet?: Set<string>,
): GateDecision | null {
	switch (rule.type) {
		case 'allow_read_only': {
			// A server's own claim about its own tool cannot settle this. See
			// `isTrustedReadOnly`: a self-declaration may raise the requirement
			// and never lower it.
			if (!isTrustedReadOnly(toolDef, toolInput)) return null

			// Read-only is a claim about the DATA a call returns, not about the
			// CHANNEL it travels over. A tool can be `readOnlyHint: true` AND
			// `provenance.readOnlyHintTrusted: true` — a claim this rule would
			// otherwise take at face value — and still cross the one boundary
			// the gate exists to police, because `isTrustedReadOnly` only ever
			// asks whether the CLAIM is trustworthy. `excludeCategories` lets a
			// rule say "not this channel, however trusted the claim", falling
			// through exactly as if nothing had matched.
			const category = toolDef?.category
			if (category && rule.excludeCategories?.includes(category)) return null

			return 'allow'
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

		case 'argument_pattern': {
			if (!compiledPattern) return null
			if (!nameSet?.has(toolName)) return null

			if (typeof toolInput !== 'object' || toolInput === null) return null
			const value = (toolInput as Record<string, unknown>)[rule.argument]

			// The subject is the argument's own value, which is the whole point
			// — `^git push` here means what a reader expects, where the same
			// pattern against the serialised object could never match.
			//
			// Numbers and booleans are rendered rather than skipped, because
			// `String(4000)` is unambiguous and anchorable. Objects and arrays
			// are NOT: no string a pattern could match says anything true about
			// a structured value, and serialising one would put us back where
			// `custom_pattern` already is. A rule about the shape of an input
			// is a rule about the tool, and `deny_by_name` is where it belongs.
			const subject =
				typeof value === 'string'
					? value
					: typeof value === 'number' || typeof value === 'boolean'
						? String(value)
						: undefined
			if (subject === undefined) return null

			// A command line is not one string, and testing it as one is how a
			// prohibition gets bypassed: `^git push` sees `git push origin main`
			// and does not see `true; git push origin main`. See
			// `decomposeCommandLine` for the measurement and for why the two
			// decisions must read the result differently.
			const { segments, opaque } = decomposeCommandLine(subject)

			if (rule.decision === 'deny') {
				// ANY segment. The whole subject is tested first so an
				// unanchored deny keeps matching across a boundary, which
				// splitting alone would have taken away.
				if (compiledPattern.test(subject)) return 'deny'
				return segments.some((segment) => compiledPattern.test(segment)) ? 'deny' : null
			}

			// EVERY segment, and nothing that hides one. Permission is a claim
			// about the whole line; granting it from one matching part is what
			// let `git status && rm -rf ~` through an allow rule for
			// `^git status`.
			if (opaque) return null
			return segments.every((segment) => compiledPattern.test(segment)) ? 'allow' : null
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
