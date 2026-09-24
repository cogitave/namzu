import { DANGEROUS_PATTERNS } from '../constants/tools/index.js'
import { isTrustedReadOnly } from '../tools/trusted-read-only.js'
import { matchesSourceIdGlob } from '../toolsets/source-glob.js'
import type { ToolSourceRef } from '../toolsets/types.js'
import type { AuthorizationRule, GateDecision } from '../types/authorization/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { decodedCommands, decomposeCommandLine } from './command-line.js'
import type { ShellDialect } from './shell-lexer.js'

export interface EvaluateRuleOptions {
	/**
	 * The shell the tool will run a command-line argument in. Default `sh`:
	 * every construct bash and a POSIX shell read differently makes the line
	 * opaque. `ToolDefinition.commandDialect` supplies it for a tool.
	 */
	readonly commandDialect?: ShellDialect
	/**
	 * Where the tool named by this call came from, when the caller has a
	 * `ToolManager` to ask (`ToolManager.sourceOf`). `allow_read_only` reads
	 * this to decide whether an MCP server's own `readOnlyHint` is trusted;
	 * absent, `isTrustedReadOnly` treats the tool as host-defined, matching a
	 * caller with no manager to ask.
	 */
	readonly toolSource?: ToolSourceRef
}

export function evaluateRule(
	rule: AuthorizationRule,
	toolName: string,
	toolInput: unknown,
	toolDef: ToolDefinition | undefined,
	compiledPattern?: RegExp,
	nameSet?: Set<string>,
	options: EvaluateRuleOptions = {},
): GateDecision | null {
	// A command line is read for the shell that will run it. Not knowing
	// which, the reading that holds for every POSIX shell is the safe one.
	const dialect = options.commandDialect ?? 'sh'
	switch (rule.type) {
		case 'allow_read_only': {
			// A server's own claim about its own tool cannot settle this. See
			// `isTrustedReadOnly`: a self-declaration may raise the requirement
			// and never lower it.
			if (!isTrustedReadOnly(toolDef, toolInput, options.toolSource)) return null

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

			// A read that sends the operator's screen to the model provider is
			// the one read a person may want to allow first
			// (`ToolDefinition.capturesScreen`). It falls through to the review
			// policy, which asks once per session when the host keeps a consent
			// record and approves it as the read it is otherwise. An explicit
			// allow rule for the tool still allows it here.
			if (capturesScreen(toolDef, toolInput)) return null

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

		case 'by_source': {
			const source = options.toolSource
			return source !== undefined && matchesSourceIdGlob(source.id, rule.sourceIdGlob)
				? rule.decision
				: null
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

			// A path the tool itself declares is a path, not a command line.
			// Read as shell, `app/(auth)/page.tsx` is a syntax error, and an
			// opaque reading would withdraw every allow rule written for it.
			if (
				typeof value === 'string' &&
				toolDef?.pathArgument === rule.argument &&
				toolDef.commandArgument !== rule.argument
			) {
				return compiledPattern.test(subject) ? rule.decision : null
			}

			// A command line is not one string, and testing it as one is how a
			// prohibition gets bypassed: `^git push` sees `git push origin main`
			// and does not see `true; git push origin main`. See
			// `decomposeCommandLine` for the measurement and for why the
			// decisions must read the result differently.
			//
			// An argument the tool declares as a canonical URL is not a command
			// line, and cutting it at `&` would make an `allow` for a site
			// decline every address with a query string. See
			// `ToolDefinition.urlArgument`.
			const isUrl = toolDef?.urlArgument === rule.argument
			const { segments, opaque } = isUrl
				? { segments: [subject], opaque: false }
				: decomposeCommandLine(subject, dialect)

			if (rule.decision === 'deny' || rule.decision === 'review') {
				// ANY segment. The whole subject is tested first so an
				// unanchored deny keeps matching across a boundary, which
				// splitting alone would have taken away. Then each command's
				// words as bash passes them, so that `'git' push` is `git push`.
				//
				// `review` reads like `deny`, because it is a restriction too: a
				// rule that asks before `git push` must ask before
				// `true; git push` as well. Matching too much costs a prompt;
				// matching too little skips the question the operator asked for.
				if (compiledPattern.test(subject)) return rule.decision
				if (segments.some((segment) => compiledPattern.test(segment))) return rule.decision
				if (isUrl) return null
				return decodedCommands(subject, dialect).some((text) => compiledPattern.test(text))
					? rule.decision
					: null
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

		case 'predicate': {
			// A rule that throws has not decided the call is safe. Reading the
			// exception as "no opinion" would let the next rule, or the mode,
			// approve what this one was written to refuse.
			try {
				return rule.decide({
					toolName,
					toolInput,
					toolDef,
					commandDialect: dialect,
				})
			} catch {
				return 'deny'
			}
		}

		default: {
			const _exhaustive: never = rule
			throw new Error(`Unhandled verification rule type: ${(_exhaustive as { type: string }).type}`)
		}
	}
}

function capturesScreen(toolDef: ToolDefinition | undefined, toolInput: unknown): boolean {
	if (!toolDef?.capturesScreen) return false
	try {
		return toolDef.capturesScreen(toolInput)
	} catch {
		// A declaration that cannot answer is not trusted to say "no".
		return true
	}
}
