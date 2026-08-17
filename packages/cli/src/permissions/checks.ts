/**
 * An operator's own expectations about their own permission table, checked.
 *
 * ## Why config needs tests at all
 *
 * A `[permissions]` entry is a glob compiled to a regular expression and
 * evaluated against a subject the operator never sees. Every part of that
 * pipeline has been wrong at least once in this repository, and each time the
 * failure was silent and permissive: a rule that read like a prohibition and
 * decided nothing, an `allow` whose match began wherever the text did, a glob
 * whose trailing star reached past the end of a command. In every case the
 * config LOOKED right, and nothing the operator could run would have told them
 * otherwise.
 *
 * A test case attached to the policy turns that into a startup failure. It is
 * the same argument as `a-falsifiable-comment-is-a-test`, applied to
 * configuration: a claim nobody can check is a claim nobody should believe.
 *
 * ## What a check is
 *
 * A tool, an input, and the decision the operator believes their table
 * produces:
 *
 *     "permissionChecks": [
 *       { "tool": "bash", "input": { "command": "git status --short" }, "expect": "allow" },
 *       { "tool": "bash", "input": { "command": "git status && rm -rf ~" }, "expect": "ask" }
 *     ]
 *
 * The second is the interesting one. It asserts a NEGATIVE — that the table
 * does not stretch to cover a command the operator never named — and a negative
 * is exactly what a table of globs cannot be read for.
 *
 * ## Why it runs the real gate
 *
 * Re-implementing the matching here would check this file against itself. The
 * check compiles the operator's table to rules and hands them to the same
 * `AuthorizationGate` a run uses, so what it verifies is the decision that will
 * actually be taken.
 *
 * The floor is deliberately OFF while checking. `denyDangerousPatterns` would
 * answer for the four catastrophic commands before any operator rule was
 * consulted, so a check written about the table would silently be answered by
 * something else — and would keep passing after the rule it was written for was
 * deleted.
 */

import { AuthorizationGate, type AuthorizationRule, NOOP_LOGGER } from '@namzu/sdk'

import type { CompileDiagnostic, PermissionEffect } from './rules.js'
import { isPermissionEffect } from './rules.js'

/** One operator-authored expectation about the permission table. */
export interface PermissionCheck {
	readonly tool: string
	readonly input: Readonly<Record<string, unknown>>
	readonly expect: PermissionEffect
}

export type PermissionChecksConfig = readonly PermissionCheck[]

/**
 * The gate's vocabulary against the operator's.
 *
 * `review` is what the gate returns when nothing decided, and `ask` is what the
 * operator writes for it. Two names for one outcome is a translation, not a
 * mapping to be got wrong in one direction.
 */
function asEffect(decision: 'allow' | 'deny' | 'review'): PermissionEffect {
	return decision === 'review' ? 'ask' : decision
}

/**
 * Evaluate every check against the compiled table.
 *
 * Returns a diagnostic per failure rather than throwing, for the reason the
 * compiler already collects rather than throws: one wrong expectation should
 * cost that line and not the other nine. But a failure must be SAID — a check
 * that silently passes is worse than no check, because it is a reason to
 * believe.
 */
export function verifyPermissionChecks(
	rules: readonly AuthorizationRule[],
	checks: PermissionChecksConfig | undefined,
): CompileDiagnostic[] {
	if (!checks || checks.length === 0) return []

	const diagnostics: CompileDiagnostic[] = []
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: false,
			// Off on purpose; see the note at the top of this file.
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)

	for (const [index, check] of checks.entries()) {
		const where = `permissionChecks[${index}]`

		if (typeof check?.tool !== 'string' || check.tool === '') {
			diagnostics.push({ tool: where, message: 'expected a "tool" naming the tool to evaluate' })
			continue
		}
		if (typeof check.input !== 'object' || check.input === null || Array.isArray(check.input)) {
			diagnostics.push({
				tool: where,
				message: `expected an "input" object for ${check.tool}; got ${describe(check.input)}`,
			})
			continue
		}
		if (!isPermissionEffect(check.expect)) {
			diagnostics.push({
				tool: where,
				message: `expected "expect" to be "allow", "ask" or "deny"; got ${JSON.stringify(check.expect)}`,
			})
			continue
		}

		const verdict = gate.evaluate({
			toolName: check.tool,
			toolInput: check.input,
			toolDef: undefined,
		})
		const actual = asEffect(verdict.decision)
		if (actual === check.expect) continue

		// The reason is quoted because it names the rule that decided, which is
		// the difference between "your config is wrong" and a message someone
		// can act on without re-deriving the whole table.
		diagnostics.push({
			tool: where,
			message: `${check.tool} ${JSON.stringify(check.input)} is "${actual}", not the expected "${check.expect}" — ${verdict.reason}`,
		})
	}

	return diagnostics
}

function describe(value: unknown): string {
	if (value === null) return 'null'
	return Array.isArray(value) ? 'an array' : typeof value
}
