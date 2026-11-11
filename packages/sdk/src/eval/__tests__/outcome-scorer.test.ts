import { describe, expect, it } from 'vitest'

import type { TurnOutcome } from '../../types/session/outcome.js'
import type { Turn } from '../../types/session/turn.js'
import { evalTurnFromTurn } from '../from-turn.js'
import { outcomeScorer } from '../scorers.js'
import type { EvalCase, EvalTurn } from '../types.js'

const record = (verdict: TurnOutcome['verdict']): TurnOutcome => ({
	verdict,
	basis: 'calls',
	changes: { total: 0, paths: [], outsideKnownTools: false },
	checks: [],
})

const evalTurn = (outcome?: TurnOutcome): EvalTurn => ({
	output: 'done',
	steps: [],
	toolCalls: [],
	totalTokens: 0,
	totalCostUsd: 0,
	durationMs: 0,
	...(outcome ? { outcome } : {}),
})

const aCase: EvalCase = { name: 'c', input: null }

describe('the outcome scorer', () => {
	it('scores 1 and names the verdict when it is one of the given set', async () => {
		const score = await outcomeScorer(['checked', 'unchanged']).score(
			evalTurn(record('checked')),
			aCase,
		)
		expect(score.score).toBe(1)
		expect(score.reason).toContain('checked')
	})

	it('scores 0 and names the verdict when it is not', async () => {
		const score = await outcomeScorer(['checked']).score(evalTurn(record('failing')), aCase)
		expect(score.score).toBe(0)
		expect(score.reason).toContain('failing')
		expect(score.details).toMatchObject({ verdict: 'failing' })
	})

	it('is unavailable, not wrong, when the turn has no record', async () => {
		const score = await outcomeScorer(['checked']).score(evalTurn(), aCase)
		expect(score.unavailable).toBe(true)
	})
})

describe('projecting a turn for the eval suites', () => {
	const base = {
		tokenUsage: { totalTokens: 0 },
		costInfo: { totalCost: 0 },
		startedAt: 0,
		endedAt: 1,
		result: 'ok',
	} as unknown as Turn

	it('carries the outcome record through', () => {
		const projected = evalTurnFromTurn({ ...base, outcome: record('stale') })
		expect(projected.outcome?.verdict).toBe('stale')
	})

	it('has no outcome key when the turn has none', () => {
		expect('outcome' in evalTurnFromTurn(base)).toBe(false)
	})
})
