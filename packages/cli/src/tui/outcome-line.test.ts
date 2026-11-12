import type { TurnOutcome } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { claimMismatchLine, goalEndingLine, outcomeLine } from './outcome-line.js'

function outcome(over: Partial<TurnOutcome> = {}): TurnOutcome {
	return {
		verdict: 'checked',
		basis: 'workspace',
		changes: { total: 4, paths: ['a', 'b', 'c', 'd'], outsideKnownTools: false },
		checks: [{ command: 'pnpm test', step: 2, result: 'passed', exitCode: 0, fresh: true }],
		...over,
	}
}

const none = { total: 0, paths: [], outsideKnownTools: false }

describe('the line a turn ends with', () => {
	it.each<[string, Partial<TurnOutcome>, string]>([
		['checked', {}, 'Changed 4 files · checked: pnpm test passed, nothing changed since'],
		['unchecked', { verdict: 'unchecked', checks: [] }, 'Changed 4 files · not checked'],
		[
			'failing',
			{
				verdict: 'failing',
				checks: [{ command: 'pnpm test', step: 2, result: 'failed', exitCode: 1 }],
			},
			'Changed 4 files · pnpm test failed',
		],
		[
			'stale',
			{
				verdict: 'stale',
				checks: [{ command: 'pnpm test', step: 2, result: 'passed', fresh: false }],
			},
			'Changed 4 files · pnpm test passed, then files changed again',
		],
		[
			'masked by a pipe',
			{
				verdict: 'inconclusive',
				checks: [{ command: 'pnpm test | tail -5', step: 2, result: 'masked', exitCode: 0 }],
			},
			'Changed 4 files · ran pnpm test | tail -5, but the pipe hides whether it passed',
		],
		[
			'masked by something else',
			{
				verdict: 'inconclusive',
				checks: [{ command: 'pnpm test || true', step: 2, result: 'masked', exitCode: 0 }],
			},
			'Changed 4 files · ran pnpm test || true, but the command line hides whether it passed',
		],
		[
			'not seen',
			{ verdict: 'inconclusive', checks: [{ command: 'pnpm test', step: 2, result: 'unsettled' }] },
			'Changed 4 files · ran pnpm test, but its result was not seen',
		],
		[
			'passed, freshness unknown',
			{ verdict: 'inconclusive', checks: [{ command: 'pnpm test', step: 2, result: 'passed' }] },
			'Changed 4 files · pnpm test passed, but it is not known whether files changed after it',
		],
		[
			'one file',
			{
				verdict: 'unchecked',
				checks: [],
				changes: { total: 1, paths: ['a'], outsideKnownTools: false },
			},
			'Changed 1 file · not checked',
		],
		[
			'a change no edit tool explains',
			{
				verdict: 'unchecked',
				checks: [],
				changes: { total: 0, paths: [], outsideKnownTools: true },
			},
			'Changed files outside the edit tools · not checked',
		],
		[
			'a failing check with nothing changed',
			{
				verdict: 'failing',
				changes: none,
				checks: [{ command: 'pnpm lint', step: 1, result: 'failed', exitCode: 1 }],
			},
			'No files changed · pnpm lint failed',
		],
	])('%s', (_name, over, line) => {
		expect(outcomeLine(outcome(over))).toBe(line)
	})

	it('is nothing for a turn that changed nothing, and nothing for no record', () => {
		expect(
			outcomeLine(outcome({ verdict: 'unchanged', checks: [], changes: none })),
		).toBeUndefined()
		expect(outcomeLine(undefined)).toBeUndefined()
	})

	it('does not let a command the model wrote reach the terminal as control characters', () => {
		const line = outcomeLine(
			outcome({
				checks: [
					{
						command: 'pnpm test\u001b[2J\u001b]0;pwned\u0007\nnext',
						step: 2,
						result: 'passed',
						fresh: true,
					},
				],
			}),
		)
		expect(line).toBeDefined()
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
		expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
	})

	it('cuts a long command short', () => {
		const line = outcomeLine(
			outcome({
				checks: [
					{ command: `pnpm test ${'x'.repeat(200)}`, step: 2, result: 'passed', fresh: true },
				],
			}),
		)
		expect(line?.length).toBeLessThan(140)
		expect(line).toContain('…')
	})

	it('says so when it cannot be told whether files changed', () => {
		expect(outcomeLine(outcome({ verdict: 'unknown', changes: none, checks: [] }))).toBe(
			'A command ran that may have changed files · cannot tell',
		)
	})

	it('never says no files changed for a turn that was only not checked', () => {
		expect(outcomeLine(outcome({ verdict: 'unchecked', changes: none, checks: [] }))).toBe(
			'Changed files · not checked',
		)
	})
})

describe('the line under it when the answer contradicts the record', () => {
	const mismatch = {
		claim: 'tests' as const,
		said: 'the tests pass',
		quote: 'All tests pass',
		record: 'check-failed' as const,
		recordSays: 'pnpm test failed',
	}

	it('is one sentence of the kernel, naming the claim and the record', () => {
		expect(claimMismatchLine(mismatch)).toBe(
			'The answer says the tests pass. The record: pnpm test failed.',
		)
	})

	it('is nothing when there is no mismatch', () => {
		expect(claimMismatchLine(undefined)).toBeUndefined()
	})

	it('makes a command from the model printable', () => {
		const line = claimMismatchLine({ ...mismatch, recordSays: 'pnpm\u009b31m test\nfailed' })
		expect(line).toBe('The answer says the tests pass. The record: pnpm 31m test failed.')
	})
})

describe('goalEndingLine', () => {
	it('says which of the three endings it was, with what the record held', () => {
		expect(
			goalEndingLine({
				goalId: 'g',
				ending: 'confirmed',
				sentence: '`pnpm test` passed and nothing changed after it',
				refusals: 1,
			}),
		).toBe('Goal confirmed by the record: `pnpm test` passed and nothing changed after it.')
		expect(
			goalEndingLine({
				goalId: 'g',
				ending: 'stated-not-checked',
				sentence: 'nothing changed and no check ran',
				refusals: 0,
			}),
		).toBe(
			'Goal stated, not checked: the record cannot confirm it (nothing changed and no check ran).',
		)
		expect(
			goalEndingLine({
				goalId: 'g',
				ending: 'not-confirmed',
				sentence: '`pnpm test` failed',
				refusals: 3,
			}),
		).toBe('Goal not confirmed: the record says `pnpm test` failed.')
	})

	it('says nothing when no goal ended', () => {
		expect(goalEndingLine(undefined)).toBeUndefined()
	})

	it('makes a command from the record printable', () => {
		expect(
			goalEndingLine({
				goalId: 'g',
				ending: 'not-confirmed',
				sentence: 'a\u001b[31m failed',
				refusals: 3,
			}),
		).not.toContain('\u001b')
	})
})
