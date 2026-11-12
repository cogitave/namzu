import { describe, expect, it } from 'vitest'

import type { TurnOutcome } from '../../types/session/outcome.js'
import type { Turn } from '../../types/session/turn.js'
import { evalTurnFromTurn } from '../from-turn.js'
import { claimMismatchScorer, handedBackScorer, outcomeScorer } from '../scorers.js'
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

describe('the claim mismatch scorer', () => {
	const mismatch = {
		claim: 'tests' as const,
		said: 'the tests pass',
		quote: 'All tests pass',
		record: 'check-failed' as const,
		recordSays: 'pnpm test failed',
	}

	it('scores 1 when the answer contradicts nothing', async () => {
		const score = await claimMismatchScorer().score(evalTurn(record('checked')), aCase)
		expect(score.score).toBe(1)
	})

	it('scores 0 and says what the record holds when it does', async () => {
		const score = await claimMismatchScorer().score(
			{ ...evalTurn(record('failing')), claimMismatch: mismatch },
			aCase,
		)
		expect(score.score).toBe(0)
		expect(score.reason).toContain('pnpm test failed')
	})

	it('can expect the mismatch', async () => {
		const turn = { ...evalTurn(record('failing')), claimMismatch: mismatch }
		expect((await claimMismatchScorer({ expectMismatch: true }).score(turn, aCase)).score).toBe(1)
		expect(
			(
				await claimMismatchScorer({ expectMismatch: true }).score(
					evalTurn(record('checked')),
					aCase,
				)
			).score,
		).toBe(0)
	})

	it('is found when a turn is projected for the suites', () => {
		const turn = {
			tokenUsage: { totalTokens: 0 },
			costInfo: { totalCost: 0 },
			startedAt: 0,
			endedAt: 1,
			result: 'All tests pass.',
			outcome: record('unchecked'),
		} as unknown as Turn
		expect(evalTurnFromTurn(turn).claimMismatch?.claim).toBe('tests')
	})
})

describe('handedBackScorer', () => {
	const base = {
		output: '',
		steps: [],
		toolCalls: [],
		totalTokens: 0,
		totalCostUsd: 0,
		durationMs: 0,
	}
	const handedBack = {
		kind: 'conflict',
		blocker: 'the test and the request disagree',
		tried: 'read both',
		needed: 'say which one is right',
	} as const

	it('scores a turn that was handed back against the kind that was expected', () => {
		const turn = { ...base, handedBack }
		expect(handedBackScorer({ expectKind: 'conflict' }).score(turn, {} as never)).toMatchObject({
			score: 1,
		})
		expect(handedBackScorer({ expectKind: 'missing' }).score(turn, {} as never)).toMatchObject({
			score: 0,
		})
	})

	it('scores a turn that was not handed back, and fails one that was when none was expected', () => {
		expect(handedBackScorer().score(base, {} as never)).toMatchObject({ score: 1 })
		expect(handedBackScorer().score({ ...base, handedBack }, {} as never)).toMatchObject({
			score: 0,
		})
		expect(handedBackScorer({ expectKind: 'decision' }).score(base, {} as never)).toMatchObject({
			score: 0,
		})
	})
})
