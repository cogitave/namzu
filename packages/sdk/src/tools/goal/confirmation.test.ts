import { describe, expect, it } from 'vitest'

import type { TurnOutcome, TurnOutcomeCheck } from '../../types/session/outcome.js'
import {
	DEFAULT_GOAL_REFUSALS,
	type GoalStatement,
	decideGoalConfirmation,
	describeGoalEnding,
	recordSentence,
} from './confirmation.js'

function check(
	result: TurnOutcomeCheck['result'],
	fresh?: boolean,
	command = 'pnpm test',
): TurnOutcomeCheck {
	return { command, step: 1, result, ...(fresh !== undefined ? { fresh } : {}) }
}

function record(
	verdict: TurnOutcome['verdict'],
	checks: TurnOutcomeCheck[] = [],
	total = 0,
): TurnOutcome {
	return {
		verdict,
		basis: 'workspace',
		changes: { total, paths: [], outsideKnownTools: false },
		checks,
	}
}

type Row = {
	readonly name: string
	readonly statement: GoalStatement
	readonly record: TurnOutcome | undefined
	readonly refusals?: number
	readonly earlier?: boolean
	readonly expect: 'confirmed' | 'stated-not-checked' | 'not-confirmed' | 'refuse'
}

const ROWS: readonly Row[] = [
	{
		name: 'a check passed and nothing changed after it',
		statement: 'met',
		record: record('checked', [check('passed', true)], 2),
		expect: 'confirmed',
	},
	{
		name: 'a check passed in a turn that changed nothing',
		statement: 'met',
		record: record('unchanged', [check('passed', true)]),
		expect: 'confirmed',
	},
	{
		name: 'a check failed',
		statement: 'met',
		record: record('failing', [check('failed')], 1),
		expect: 'refuse',
	},
	{
		name: 'files changed after the last passing check',
		statement: 'met',
		record: record('stale', [check('passed', false)], 2),
		expect: 'refuse',
	},
	{
		name: 'files changed and no check ran',
		statement: 'met',
		record: record('unchecked', [], 1),
		expect: 'refuse',
	},
	{
		name: 'a check ran but its result could not be read',
		statement: 'met',
		record: record('inconclusive', [check('masked')], 1),
		expect: 'refuse',
	},
	{
		name: 'nothing changed and nothing ran',
		statement: 'met',
		record: record('unchanged'),
		expect: 'stated-not-checked',
	},
	{
		name: 'nothing changed and nothing ran, after an earlier round that changed files',
		statement: 'met',
		record: record('unchanged'),
		earlier: true,
		expect: 'refuse',
	},
	{
		name: 'whether anything changed cannot be told (a later check could not clear it, so no refusal)',
		statement: 'met',
		record: record('unknown'),
		expect: 'stated-not-checked',
	},
	{
		name: 'there is no record',
		statement: 'met',
		record: undefined,
		expect: 'stated-not-checked',
	},
	{
		name: 'the third refusal was already given and the check still fails',
		statement: 'met',
		record: record('failing', [check('failed')], 1),
		refusals: DEFAULT_GOAL_REFUSALS,
		expect: 'not-confirmed',
	},
	{
		name: 'one refusal is left and the check still fails',
		statement: 'met',
		record: record('failing', [check('failed')], 1),
		refusals: DEFAULT_GOAL_REFUSALS - 1,
		expect: 'refuse',
	},
	{
		name: 'the model says it could not make the check pass',
		statement: 'could-not',
		record: record('failing', [check('failed')], 1),
		expect: 'not-confirmed',
	},
	{
		name: 'the model says it could not, and the record holds a pass',
		statement: 'could-not',
		record: record('checked', [check('passed', true)], 1),
		expect: 'not-confirmed',
	},
	{
		name: 'the model says no check exists and files changed',
		statement: 'no-check',
		record: record('unchecked', [], 3),
		expect: 'stated-not-checked',
	},
	{
		name: 'the model says no check exists and nothing changed',
		statement: 'no-check',
		record: record('unchanged'),
		expect: 'stated-not-checked',
	},
	{
		name: 'the model says no check exists and a check failed',
		statement: 'no-check',
		record: record('failing', [check('failed')], 1),
		expect: 'not-confirmed',
	},
	{
		name: 'the model says no check exists and a check passed',
		statement: 'no-check',
		record: record('checked', [check('passed', true)], 1),
		expect: 'confirmed',
	},
]

describe('the decision about a goal the model reports as met', () => {
	for (const row of ROWS) {
		it(`${row.name}: ${row.expect}`, () => {
			const decision = decideGoalConfirmation({
				statement: row.statement,
				record: row.record,
				refusals: row.refusals ?? 0,
				maxRefusals: DEFAULT_GOAL_REFUSALS,
				...(row.earlier ? { earlierRoundsChanged: true } : {}),
			})
			expect(decision.kind === 'refuse' ? 'refuse' : decision.ending).toBe(row.expect)
		})
	}

	it('says in its own words what the record holds and how to put it right', () => {
		const decision = decideGoalConfirmation({
			statement: 'met',
			record: record('stale', [check('passed', false)], 2),
			refusals: 0,
			maxRefusals: 3,
		})
		expect(decision.kind).toBe('refuse')
		if (decision.kind !== 'refuse') return
		expect(decision.note).toContain(
			'The record says files changed after the last passing check. Run the check again, or say plainly that you could not.',
		)
		expect(decision.note).toContain('no-check-available')
	})

	it('never refuses with no refusals allowed', () => {
		const decision = decideGoalConfirmation({
			statement: 'met',
			record: record('unchecked', [], 1),
			refusals: 0,
			maxRefusals: 0,
		})
		expect(decision).toMatchObject({ kind: 'end', ending: 'not-confirmed' })
	})
})

describe('the record in words', () => {
	it('shows a command only when it can be shown as plain data', () => {
		expect(recordSentence(record('failing', [check('failed', undefined, 'echo "x" `y`')], 1))).toBe(
			'a command failed',
		)
		expect(recordSentence(record('failing', [check('failed')], 1))).toBe('`pnpm test` failed')
	})

	it('writes the closing line of each ending, with the record in it', () => {
		expect(describeGoalEnding({ ending: 'confirmed', sentence: '`pnpm test` passed' })).toBe(
			'Goal confirmed by the record: `pnpm test` passed.',
		)
		expect(describeGoalEnding({ ending: 'stated-not-checked', sentence: 'nothing changed' })).toBe(
			'Goal stated, not checked: the record cannot confirm it (nothing changed).',
		)
		expect(describeGoalEnding({ ending: 'not-confirmed', sentence: '`pnpm test` failed' })).toBe(
			'Goal not confirmed: the record says `pnpm test` failed.',
		)
	})
})
