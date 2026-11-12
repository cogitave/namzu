import { describe, expect, it } from 'vitest'

import type { TurnOutcome, TurnOutcomeCheck } from '../../../../types/session/outcome.js'
import { compareAnswerToOutcome, describeAnswerClaimMismatch } from '../answer-claims.js'

const check = (command: string, result: TurnOutcomeCheck['result']): TurnOutcomeCheck => ({
	command,
	step: 1,
	result,
	...(result === 'failed' ? { exitCode: 1 } : {}),
})

const record = (
	verdict: TurnOutcome['verdict'],
	checks: readonly TurnOutcomeCheck[] = [],
	changed = 1,
): TurnOutcome => ({
	verdict,
	basis: 'calls',
	changes: { total: changed, paths: changed ? ['src/a.ts'] : [], outsideKnownTools: false },
	checks,
})

const failing = record('failing', [check('pnpm check', 'failed')])
const unchecked = record('unchecked')
const unreadable = record('inconclusive', [check('pnpm test | tail', 'masked')])

/**
 * Every row says what the comparison must return for one answer against one
 * record: `claim` names the claim it must find, `null` means silence. The
 * rows are the measure of the claim reader; a row that is hard stays.
 */
const rows: readonly {
	name: string
	answer: string
	record: TurnOutcome
	expect: string | null
}[] = [
	// Plain claims, which must be found.
	{ name: 'all tests pass', answer: 'All tests pass.', record: failing, expect: 'tests' },
	{
		name: 'the tests passed',
		answer: 'I fixed the bug and the tests passed.',
		record: failing,
		expect: 'tests',
	},
	{
		name: 'tests are green',
		answer: 'The unit tests are all green now.',
		record: unchecked,
		expect: 'tests',
	},
	{
		name: 'tests have been passing',
		answer: 'Existing tests have been passing throughout.',
		record: unreadable,
		expect: 'tests',
	},
	{ name: 'test suite passes', answer: 'The test suite passes.', record: failing, expect: 'tests' },
	{
		name: 'no test failures',
		answer: 'There are no test failures.',
		record: failing,
		expect: 'tests',
	},
	{ name: 'build succeeds', answer: 'The build succeeds.', record: failing, expect: 'build' },
	{ name: 'builds cleanly', answer: 'It builds cleanly.', record: unchecked, expect: 'build' },
	{
		name: 'compiles successfully',
		answer: 'Everything compiles successfully.',
		record: unchecked,
		expect: 'build',
	},
	{ name: 'lint is clean', answer: 'Lint is clean.', record: failing, expect: 'lint' },
	{ name: 'no lint errors', answer: 'I see no lint errors.', record: unchecked, expect: 'lint' },
	{ name: 'typecheck passes', answer: 'Typecheck passes.', record: failing, expect: 'typecheck' },
	{
		name: 'type checking is clean',
		answer: 'Type checking is clean.',
		record: unreadable,
		expect: 'typecheck',
	},
	{
		name: 'no type errors',
		answer: 'There are no type errors.',
		record: unchecked,
		expect: 'typecheck',
	},
	{ name: 'all checks pass', answer: 'All checks pass.', record: failing, expect: 'checks' },
	{
		name: 'label form',
		answer: '- Tests: passing\n- Notes: none',
		record: failing,
		expect: 'tests',
	},
	{ name: 'bold label form', answer: '**Build**: success', record: unchecked, expect: 'build' },
	{
		name: 'claim in the middle of a long answer',
		answer: `${'I read the module and traced the call path through the loader. '.repeat(30)}All tests pass. ${'The change is small and local to one function. '.repeat(30)}`,
		record: failing,
		expect: 'tests',
	},
	{
		name: 'second sentence of a mixed answer',
		answer: 'I renamed the helper. The tests pass, and the diff is small.',
		record: failing,
		expect: 'tests',
	},
	{
		name: 'one clause negated and another a plain claim',
		answer: 'The docs were not updated, but the tests pass.',
		record: failing,
		expect: 'tests',
	},
	{
		name: 'two claims, the first is reported',
		answer: 'The build succeeds and lint is clean.',
		record: unchecked,
		expect: 'build',
	},

	// Negations.
	{ name: 'did not pass', answer: 'The tests did not pass.', record: failing, expect: null },
	{ name: 'not all pass', answer: 'Not all tests pass.', record: failing, expect: null },
	{
		name: 'could not run',
		answer: 'I could not run the tests, so I cannot say whether they pass.',
		record: unchecked,
		expect: null,
	},
	{ name: 'still fail', answer: 'The tests still fail.', record: failing, expect: null },
	{ name: 'no tests pass', answer: 'No tests pass yet.', record: failing, expect: null },

	// Hedges and conditions.
	{ name: 'if', answer: 'If the tests pass, this is done.', record: failing, expect: null },
	{ name: 'should', answer: 'The tests should pass now.', record: unchecked, expect: null },
	{
		name: 'once',
		answer: 'Once the build succeeds you can merge.',
		record: unchecked,
		expect: null,
	},
	{ name: 'hope', answer: 'I hope the tests pass.', record: unchecked, expect: null },
	{
		name: 'to confirm',
		answer: 'Run it again to confirm the tests pass.',
		record: unchecked,
		expect: null,
	},
	{ name: 'must', answer: 'The tests must pass before release.', record: failing, expect: null },
	{
		name: 'will',
		answer: 'The build will succeed after you install.',
		record: unchecked,
		expect: null,
	},
	{
		name: 'partial',
		answer: 'The tests pass except for one flaky case.',
		record: failing,
		expect: null,
	},
	{ name: 'counted partial', answer: '38 of 40 tests pass.', record: failing, expect: null },
	{
		name: 'failure in the same sentence',
		answer: 'The build succeeds but the tests fail.',
		record: failing,
		expect: null,
	},
	{
		name: 'counts with failures',
		answer: 'Tests: 40 passed, 2 failed.',
		record: failing,
		expect: null,
	},

	{
		name: 'check that',
		answer: 'Check that the tests pass before merging.',
		record: failing,
		expect: null,
	},

	// Questions.
	{ name: 'question', answer: 'Do the tests pass?', record: failing, expect: null },
	{
		name: 'question after a claim-like start',
		answer: 'Do you want me to confirm that the build succeeds?',
		record: unchecked,
		expect: null,
	},

	// Quotations and code.
	{
		name: 'quoted',
		answer: 'The log says "all tests pass" but I did not check.',
		record: failing,
		expect: null,
	},
	{
		name: 'curly quoted',
		answer: 'The comment reads “the tests pass”.',
		record: failing,
		expect: null,
	},
	{
		name: 'block quote',
		answer: 'The issue says:\n> the build succeeds on main\nI did not verify.',
		record: unchecked,
		expect: null,
	},
	{
		name: 'inline code',
		answer: 'I wrote `expect(tests).toPass()` and `tests pass` as a label.',
		record: failing,
		expect: null,
	},
	{
		name: 'fenced code',
		answer: 'Output:\n```\nAll tests pass\nBuild succeeds\n```\nThat is the sample from the docs.',
		record: failing,
		expect: null,
	},
	{ name: 'unclosed fence', answer: 'Sample:\n```\nall tests pass', record: failing, expect: null },

	// Someone else, or the past.
	{
		name: 'reported speech',
		answer: 'The CI page says the tests pass.',
		record: failing,
		expect: null,
	},
	{
		name: 'you said',
		answer: 'You said the build succeeds on your machine.',
		record: unchecked,
		expect: null,
	},
	{
		name: 'before my change',
		answer: 'The tests passed before my change.',
		record: failing,
		expect: null,
	},
	{ name: 'previously', answer: 'Lint was previously clean.', record: failing, expect: null },

	// Another language.
	{
		name: 'turkish',
		answer: 'Tum testler geciyor ve derleme basarili.',
		record: failing,
		expect: null,
	},
	{
		name: 'french',
		answer: 'Tous les tests passent et la compilation reussit.',
		record: failing,
		expect: null,
	},

	// Wrong place for a claim in the record.
	{
		name: 'a different kind of check failed',
		answer: 'Lint is clean.',
		record: record('failing', [check('pnpm test', 'failed')]),
		expect: null,
	},
	{
		name: 'tests claim, lint failed',
		answer: 'All tests pass.',
		record: record('failing', [check('pnpm lint', 'failed')]),
		expect: null,
	},
	{
		name: 'unclassified failing check',
		answer: 'All tests pass.',
		record: failing,
		expect: 'tests',
	},

	// Records that never report.
	{
		name: 'unchanged',
		answer: 'All tests pass.',
		record: record('unchanged', [], 0),
		expect: null,
	},
	{
		name: 'checked',
		answer: 'All tests pass.',
		record: record('checked', [check('pnpm test', 'passed')]),
		expect: null,
	},
	{
		name: 'stale',
		answer: 'All tests pass.',
		record: record('stale', [check('pnpm test', 'passed')]),
		expect: null,
	},
	{ name: 'unknown', answer: 'All tests pass.', record: record('unknown', [], 0), expect: null },

	// No claim at all.
	{
		name: 'no claim',
		answer: 'I changed the retry count from three to five.',
		record: failing,
		expect: null,
	},
	{
		name: 'the word tests alone',
		answer: 'I added tests for the parser and the lexer.',
		record: failing,
		expect: null,
	},
	{ name: 'singular test', answer: 'The new test passes.', record: failing, expect: null },
	{
		name: 'build as a noun',
		answer: 'The build script lives in tools/build.mjs.',
		record: unchecked,
		expect: null,
	},
	{ name: 'empty', answer: '', record: failing, expect: null },
	// A hedge or negation after the claim, and words that negate it before.
	{
		name: 'apparently after',
		answer: 'The tests pass, apparently.',
		record: failing,
		expect: null,
	},
	{
		name: 'nothing indicates',
		answer: 'Nothing indicates that the tests pass.',
		record: failing,
		expect: null,
	},
	{ name: 'zero tests pass', answer: 'Zero tests pass.', record: failing, expect: null },
	{
		name: 'passing is the goal',
		answer: 'Tests passing is the goal.',
		record: failing,
		expect: null,
	},
	{
		name: 'only, five words after',
		answer: 'The assertion: expect(tests).toPass; the tests pass on the happy path only.',
		record: failing,
		expect: null,
	},
	{
		name: 'type checker as a subject with an object',
		answer: 'The type checker passes the argument through to the callee.',
		record: unchecked,
		expect: null,
	},
	{
		name: 'tsc with an object',
		answer: 'tsc passes the flags to the compiler.',
		record: unchecked,
		expect: null,
	},
	{
		name: 'foreign negation after an English claim',
		answer: 'Testler gecti, all tests pass degil.',
		record: failing,
		expect: null,
	},

	// Plain claims that were missed at first.
	{
		name: 'pronoun after a run',
		answer: 'I ran the tests and they all pass.',
		record: failing,
		expect: 'tests',
	},
	{ name: 'all green', answer: 'All green.', record: unchecked, expect: 'checks' },
	{ name: 'whole suite', answer: 'The whole suite passes.', record: failing, expect: 'tests' },
	{ name: 'CI checks', answer: 'The CI checks pass.', record: failing, expect: 'checks' },
	{
		name: 'tsc with no errors',
		answer: 'tsc passes with no errors.',
		record: unchecked,
		expect: 'typecheck',
	},
	{ name: 'it compiles', answer: 'It compiles.', record: unchecked, expect: 'build' },
	{
		name: 'tests are not failing',
		answer: 'The tests are not failing.',
		record: failing,
		expect: 'tests',
	},
	{
		name: 'no tests are failing',
		answer: 'No tests are failing.',
		record: failing,
		expect: 'tests',
	},
	{ name: 'tests do not fail', answer: 'The tests do not fail.', record: failing, expect: 'tests' },
	{ name: 'bold label', answer: '**Tests:** passing', record: failing, expect: 'tests' },
	{
		name: 'failure in the first half of a semicolon',
		answer: 'The tests that were failing now pass; the build succeeds.',
		record: failing,
		expect: 'build',
	},
	{
		name: 'a failure after a semicolon does not cancel an earlier claim',
		answer: 'The tests pass; one lint warning remains.',
		record: failing,
		expect: 'tests',
	},
]

describe('comparing an answer with the turn record', () => {
	it('has at least forty rows', () => {
		expect(rows.length).toBeGreaterThanOrEqual(40)
	})

	it.each(rows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
		const found = compareAnswerToOutcome(row.answer, row.record)
		expect(found?.claim ?? null).toBe(row.expect)
	})

	it('says what the record holds, in the kernel words', () => {
		const found = compareAnswerToOutcome(
			'All tests pass.',
			record('failing', [check('pnpm test', 'failed')]),
		)
		expect(found && describeAnswerClaimMismatch(found)).toBe(
			'The answer says the tests pass. The record: pnpm test failed.',
		)
		const none = compareAnswerToOutcome('All tests pass.', unchecked)
		expect(none && describeAnswerClaimMismatch(none)).toBe(
			'The answer says the tests pass. The record: files changed and no check ran.',
		)
	})

	it('quotes the clause it found the claim in, clipped', () => {
		const found = compareAnswerToOutcome(`${'word '.repeat(80)}tests pass`, failing)
		expect(found?.quote.length).toBeLessThanOrEqual(160)
	})

	it('reports a chained command that failed for either half it names', () => {
		const chained = record('failing', [check('pnpm lint && pnpm test', 'failed')])
		expect(compareAnswerToOutcome('The tests pass.', chained)?.claim).toBe('tests')
		expect(compareAnswerToOutcome('Lint is clean.', chained)?.claim).toBe('lint')
		const lintOnly = record('failing', [check('pnpm lint', 'failed')])
		expect(compareAnswerToOutcome('The tests pass.', lintOnly)).toBeUndefined()
	})

	it('never throws on a record or an answer that does not have the expected shape', () => {
		const bad = [
			{ verdict: 'failing' },
			{ verdict: 'failing', checks: null },
			{ verdict: 'failing', checks: [{ result: 'failed', command: 42 }] },
			{ verdict: 'failing', checks: [null] },
		] as unknown as TurnOutcome[]
		for (const outcome of bad) {
			expect(() => compareAnswerToOutcome('All tests pass.', outcome)).not.toThrow()
		}
		expect(() => compareAnswerToOutcome(42 as unknown as string, failing)).not.toThrow()
		expect(compareAnswerToOutcome(42 as unknown as string, failing)).toBeUndefined()
		expect(compareAnswerToOutcome({} as unknown as string, failing)).toBeUndefined()
	})

	it('quotes the clause without control characters', () => {
		const found = compareAnswerToOutcome('\u001b[32mAll tests pass\u001b[0m.', failing)
		expect(
			[...(found?.quote ?? '')].every(
				(ch) => ch.charCodeAt(0) > 0x9f || (ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) < 0x7f),
			),
		).toBe(true)
	})

	it('reads no answer and no record as silence', () => {
		expect(compareAnswerToOutcome(undefined, failing)).toBeUndefined()
		expect(compareAnswerToOutcome('All tests pass.', undefined)).toBeUndefined()
	})

	it('stays fast on a very long answer', () => {
		const long = 'tests tests tests all the unit '.repeat(20000)
		expect(compareAnswerToOutcome(long, failing)).toBeUndefined()
	})
})
