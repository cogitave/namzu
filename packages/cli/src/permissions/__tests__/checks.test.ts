import { describe, expect, it } from 'vitest'

import { compilePermissions } from '../rules.js'

/**
 * A permission table is a set of globs compiled to regular expressions and
 * matched against a subject the operator never sees. Every stage of that has
 * been wrong here at least once, and each time the failure was silent and in
 * the permissive direction.
 *
 * These assert the thing that makes a check worth having: it fails when the
 * table stops meaning what its author wrote. A check that only ever passes is
 * worse than no check, because it is a reason to believe.
 */

function diagnose(
	config: Parameters<typeof compilePermissions>[0],
	checks: Parameters<typeof compilePermissions>[1],
): string[] {
	return compilePermissions(config, checks).diagnostics.map((d) => `${d.tool}: ${d.message}`)
}

const ALLOW_STATUS = { bash: { 'git status*': 'allow' } } as const

describe('a check that agrees with the table says nothing', () => {
	it('is silent when the expectation holds', () => {
		expect(
			diagnose(ALLOW_STATUS, [
				{ tool: 'bash', input: { command: 'git status --short' }, expect: 'allow' },
			]),
		).toEqual([])
	})

	it('is silent for a negative expectation that holds', () => {
		// The kind of claim a table of globs cannot be read for, and the reason
		// this feature exists: asserting that a rule does NOT stretch.
		expect(
			diagnose(ALLOW_STATUS, [
				{ tool: 'bash', input: { command: 'git status && rm -rf ~' }, expect: 'ask' },
			]),
		).toEqual([])
	})

	it('checks against an empty table rather than passing by not running', () => {
		// "Nothing decides this" is worth holding when there is no config at
		// all. An early return for absent config would make every check here
		// pass without being evaluated.
		expect(
			diagnose(undefined, [{ tool: 'bash', input: { command: 'ls' }, expect: 'ask' }]),
		).toEqual([])
		expect(
			diagnose(undefined, [{ tool: 'bash', input: { command: 'ls' }, expect: 'allow' }]),
		).toHaveLength(1)
	})
})

describe('a check that disagrees says so, and says enough to act on', () => {
	it('reports the decision it got and the one it expected', () => {
		const [message] = diagnose(ALLOW_STATUS, [
			{ tool: 'bash', input: { command: 'git status && rm -rf ~' }, expect: 'allow' },
		])

		expect(message).toContain('permissionChecks[0]')
		expect(message).toContain('"ask"')
		expect(message).toContain('"allow"')
	})

	it('quotes the rule that decided, not just the verdict', () => {
		// Without this an operator is told their config is wrong and left to
		// re-derive which of nine entries did it.
		const [message] = diagnose({ bash: { 'git push*': 'deny' } }, [
			{ tool: 'bash', input: { command: 'git push --force' }, expect: 'allow' },
		])

		// The COMPILED pattern, which only the gate's reason carries. An
		// earlier version asserted `git push` and passed a mutation that
		// dropped the reason entirely — the message echoes the input, and the
		// input says `git push` too.
		expect(message).toContain('git push.*')
	})

	it('says that nothing matched, when nothing did', () => {
		// The other half of the same defect. This message shares no text with
		// the input at all, so it can only come from the gate.
		const [message] = diagnose(ALLOW_STATUS, [
			{ tool: 'bash', input: { command: 'rm -rf ~' }, expect: 'allow' },
		])

		expect(message).toContain('No matching rule')
	})

	it('reports each failing check by its own index', () => {
		const messages = diagnose(ALLOW_STATUS, [
			{ tool: 'bash', input: { command: 'git status' }, expect: 'allow' },
			{ tool: 'bash', input: { command: 'rm -rf /' }, expect: 'allow' },
			{ tool: 'bash', input: { command: 'ls' }, expect: 'deny' },
		])

		expect(messages).toHaveLength(2)
		expect(messages[0]).toContain('permissionChecks[1]')
		expect(messages[1]).toContain('permissionChecks[2]')
	})

	it('keeps compiling the table when a check fails', () => {
		// A wrong expectation must cost that line and not the policy. The
		// opposite — dropping the rules — would turn a typo in a test into a
		// run with no permissions at all.
		const { rules } = compilePermissions(ALLOW_STATUS, [
			{ tool: 'bash', input: { command: 'anything' }, expect: 'deny' },
		])

		expect(rules).toHaveLength(1)
	})
})

describe('the check is answered by the operator table, not by something else', () => {
	it('does not let the dangerous-pattern floor answer for a rule', () => {
		// The floor would decide `rm -rf /` before any operator rule was
		// consulted, so a check written about the table would be answered by
		// something the table does not contain — and would keep passing after
		// the rule it was written for was deleted.
		expect(
			diagnose({ bash: { 'rm -rf*': 'deny' } }, [
				{ tool: 'bash', input: { command: 'rm -rf /' }, expect: 'deny' },
			]),
		).toEqual([])

		// Same command, and now nothing in the table refuses it. If the floor
		// were live this would still report `deny` and stay silent.
		expect(
			diagnose({ bash: { 'ls*': 'allow' } }, [
				{ tool: 'bash', input: { command: 'rm -rf /' }, expect: 'deny' },
			]),
		).toHaveLength(1)
	})
})

describe('a check that cannot be read is reported, never skipped', () => {
	const MALFORMED: readonly [unknown, string][] = [
		[{ input: { command: 'ls' }, expect: 'allow' }, 'tool'],
		[{ tool: 'bash', expect: 'allow' }, 'input'],
		[{ tool: 'bash', input: { command: 'ls' } }, 'expect'],
		[{ tool: 'bash', input: ['ls'], expect: 'allow' }, 'array input'],
		[{ tool: 'bash', input: { command: 'ls' }, expect: 'maybe' }, 'unknown effect'],
	]

	it.each(MALFORMED)('reports a check missing its %s', (check) => {
		// Silently skipping one would report "all checks passed" over a check
		// that never ran, which is the exact failure this feature exists to
		// remove — one level up.
		const messages = diagnose(ALLOW_STATUS, [check] as unknown as Parameters<
			typeof compilePermissions
		>[1])

		expect(messages).toHaveLength(1)
		expect(messages[0]).toContain('permissionChecks[0]')
	})

	it('says what an effect may be, rather than comparing against nonsense', () => {
		// A malformed check still produced a diagnostic without this guard —
		// `"ask" is not "maybe"` — which reads as a policy disagreement rather
		// than as a typo, and sends the operator to rewrite a rule that is
		// correct. Caught by a mutation that removed the guard and passed.
		const [message] = diagnose(ALLOW_STATUS, [
			{ tool: 'bash', input: { command: 'ls' }, expect: 'maybe' },
		] as unknown as Parameters<typeof compilePermissions>[1])

		expect(message).toContain('"allow", "ask" or "deny"')
	})
})

describe('no checks means no diagnostics', () => {
	it.each([undefined, []])('is silent for %p', (checks) => {
		expect(diagnose(ALLOW_STATUS, checks as Parameters<typeof compilePermissions>[1])).toEqual([])
	})
})
