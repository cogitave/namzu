/**
 * Operator-authored tool permissions, compiled to the kernel's rule vocabulary.
 *
 * The kernel already has the engine — `VerificationRule[]` with an
 * allow/deny/review decision, evaluated first-match-wins. What was missing was
 * any way for a person to author those rules: the CLI passed `rules: []`, so a
 * gate with seven rule types ran with none of them and every decision fell back
 * to "ask a human". This turns a `[permissions]` table into that array.
 *
 * The whole surface is pure: config in, rules out. The gate stays the only
 * thing that decides anything, which is what keeps this testable without a run.
 */

import type { VerificationRule } from '@namzu/sdk'

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
	readonly rules: readonly VerificationRule[]
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
 * The argument half is deliberately unanchored on both sides, because the
 * operator writes `git push*` while the gate sees
 * `bash {"command":"git push origin main"}`. An anchored argument pattern would
 * match nothing at all — a rule that reads like a prohibition and silently
 * permits everything, which is worse than having no rule.
 *
 * The looseness is real and worth naming: a pattern can match text in any
 * argument field, not only the one the operator had in mind. Narrowing that
 * needs a rule type that names the argument, which is the kernel's to add.
 */
export function toolScopedPattern(tool: string, pattern: string): string {
	const toolPart = escapeRegExp(tool)
	const argPart = patternToRegExpSource(pattern).slice(1, -1)
	return `^${toolPart} .*${argPart}.*$`
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
export function compilePermissions(config: PermissionsConfig | undefined): CompiledPermissions {
	const rules: VerificationRule[] = []
	const diagnostics: CompileDiagnostic[] = []
	if (!config) return { rules, diagnostics }

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
			rules.push({
				type: 'custom_pattern',
				pattern: toolScopedPattern(tool, pattern),
				target: 'both',
				decision: effect,
			})
		}
	}
	return { rules, diagnostics }
}
