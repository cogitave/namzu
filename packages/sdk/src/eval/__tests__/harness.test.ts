import { describe, expect, it } from 'vitest'

import { formatReport, runExperiment } from '../experiment.js'
import {
	completionScorer,
	containsScorer,
	customScorer,
	stepBudgetScorer,
	trajectoryScorer,
} from '../scorers.js'
import type { EvalCase, EvalRun } from '../types.js'

/**
 * There was no evaluation harness of any kind — no dataset, no scorer, no
 * judge, no trajectory assertion. So the constants that govern namzu's
 * most load-bearing behavior (`search_tools` top-k, the compaction
 * threshold, six state-list caps, every builtin tool description) were
 * tunable but not measurable: change one and the only way to learn the
 * agent now takes four tool calls where it took one was for a user to
 * hit it.
 */

function run(overrides: Partial<EvalRun> = {}): EvalRun {
	return {
		output: 'done',
		steps: [],
		toolCalls: [],
		stopReason: 'end_turn',
		totalTokens: 0,
		totalCostUsd: 0,
		durationMs: 0,
		...overrides,
	}
}

const CASE: EvalCase = { name: 'c', input: null }

describe('trajectoryScorer', () => {
	// `Scorer.score` may be async (a model-graded judge is just an async
	// predicate), so every call site awaits even when the built-in is sync.
	const score = async (expectedTools: string[], toolCalls: string[]) =>
		await trajectoryScorer().score(run({ toolCalls }), { ...CASE, expectedTools })

	it('scores an exact trajectory 1', async () => {
		expect((await score(['read', 'edit'], ['read', 'edit'])).score).toBe(1)
	})

	it('distinguishes ORDER — a set-based score could not', async () => {
		// Reading before editing is not the same run as editing then reading.
		const reversed = await score(['read', 'edit'], ['edit', 'read'])
		expect(reversed.score).toBeLessThan(1)
		expect(reversed.score).toBeGreaterThan(0)
	})

	it('penalises an extra call through precision', async () => {
		const wasteful = await score(['read'], ['read', 'read', 'read'])
		expect(wasteful.score).toBeLessThan(1)
		expect(wasteful.details?.recall).toBe(1)
		expect(wasteful.details?.precision).toBeLessThan(1)
	})

	it('penalises a missing call through recall', async () => {
		const lazy = await score(['read', 'edit', 'bash'], ['read'])
		expect(lazy.details?.precision).toBe(1)
		expect(lazy.details?.recall).toBeLessThan(1)
	})

	it('separates "wasteful" from "skipped" — a final-answer score collapses them', async () => {
		const wasteful = await score(['read', 'edit'], ['read', 'ls', 'edit'])
		const skipped = await score(['read', 'edit'], ['read'])
		expect(wasteful.score).not.toBe(skipped.score)
	})

	it('scores 1 when no tools were expected and none ran', async () => {
		expect((await score([], [])).score).toBe(1)
	})

	it('scores 0 when tools were expected and none ran', async () => {
		const s = await score(['read'], [])
		expect(s.score).toBe(0)
		expect(s.reason).toContain('no tools were called')
	})

	it('scores 0 when none were expected and some ran', async () => {
		expect((await score([], ['bash'])).score).toBe(0)
	})

	it('always explains itself', async () => {
		expect((await score(['read'], ['edit'])).reason.length).toBeGreaterThan(0)
	})
})

describe('completionScorer', () => {
	it('accepts a clean settle', async () => {
		expect((await completionScorer().score(run({ stopReason: 'end_turn' }), CASE)).score).toBe(1)
	})

	it('rejects a budget-forced stop', async () => {
		const s = await completionScorer().score(run({ stopReason: 'max_iterations' }), CASE)
		expect(s.score).toBe(0)
		expect(s.reason).toContain('max_iterations')
	})

	it('reports the error when the run threw', async () => {
		const s = await completionScorer().score(run({ error: 'boom' }), CASE)
		expect(s.score).toBe(0)
		expect(s.reason).toContain('boom')
	})
})

describe('stepBudgetScorer', () => {
	const withSteps = (n: number) => run({ steps: Array.from({ length: n }, () => ({}) as never) })

	it('passes within budget', async () => {
		expect((await stepBudgetScorer(5).score(withSteps(3), CASE)).score).toBe(1)
	})

	it('degrades proportionally past it, rather than snapping to zero', async () => {
		// A run that took 6 steps against a 5 allowance is worse than one
		// that took 20; a binary score cannot say so.
		const slight = (await stepBudgetScorer(5).score(withSteps(6), CASE)).score
		const severe = (await stepBudgetScorer(5).score(withSteps(20), CASE)).score
		expect(slight).toBeGreaterThan(severe)
		expect(slight).toBeLessThan(1)
	})
})

describe('containsScorer', () => {
	it('scores the fraction found and names what is missing', async () => {
		const s = await containsScorer('alpha', 'beta').score(run({ output: 'alpha only' }), CASE)
		expect(s.score).toBe(0.5)
		expect(s.reason).toContain('beta')
	})
})

describe('runExperiment', () => {
	const cases: EvalCase[] = [
		{ name: 'good', input: 'a', expectedTools: ['read'] },
		{ name: 'bad', input: 'b', expectedTools: ['read', 'edit'] },
	]

	it('scores every case and aggregates', async () => {
		const report = await runExperiment({
			name: 'demo',
			cases,
			scorers: [trajectoryScorer()],
			run: async (input) => run({ toolCalls: input === 'a' ? ['read'] : ['bash'] }),
		})

		expect(report.cases).toHaveLength(2)
		expect(report.passed).toBe(1)
		expect(report.failed).toBe(1)
		expect(report.byScorer.trajectory).toBeCloseTo(0.5, 5)
	})

	it('a throwing case is a RESULT, not a crash', async () => {
		// A suite whose first broken case aborts tells you nothing about the
		// other forty.
		const report = await runExperiment({
			name: 'demo',
			cases,
			scorers: [completionScorer()],
			run: async (input) => {
				if (input === 'a') throw new Error('exploded')
				return run()
			},
		})

		expect(report.cases).toHaveLength(2)
		expect(report.cases[0]?.run.error).toBe('exploded')
		expect(report.cases[1]?.passed).toBe(true)
	})

	it('a throwing scorer scores zero with the throw as its reason', async () => {
		const report = await runExperiment({
			name: 'demo',
			cases: [cases[0] as EvalCase],
			scorers: [
				customScorer('boom', () => {
					throw new Error('scorer broke')
				}),
			],
			run: async () => run(),
		})

		expect(report.cases[0]?.scores.boom?.score).toBe(0)
		expect(report.cases[0]?.scores.boom?.reason).toContain('scorer broke')
	})

	it('preserves case order under concurrency', async () => {
		const many: EvalCase[] = Array.from({ length: 8 }, (_, i) => ({
			name: `case-${i}`,
			input: i,
		}))
		const report = await runExperiment({
			name: 'demo',
			cases: many,
			concurrency: 4,
			scorers: [completionScorer()],
			run: async (input) => {
				await new Promise((r) => setTimeout(r, (8 - (input as number)) * 2))
				return run()
			},
		})

		expect(report.cases.map((c) => c.case)).toEqual(many.map((c) => c.name))
	})

	it('honours a per-case scorer override', async () => {
		const report = await runExperiment({
			name: 'demo',
			cases: [{ name: 'special', input: null, scorers: [containsScorer('xyz')] }],
			scorers: [completionScorer()],
			run: async () => run({ output: 'no match here' }),
		})

		expect(Object.keys(report.cases[0]?.scores ?? {})).toEqual(['contains'])
	})

	it('respects a partial pass threshold', async () => {
		const report = await runExperiment({
			name: 'demo',
			cases: [{ name: 'partial', input: null, expectedTools: ['read', 'edit'] }],
			scorers: [trajectoryScorer()],
			passThreshold: 0.5,
			run: async () => run({ toolCalls: ['read'] }),
		})

		expect(report.passed).toBe(1)
	})
})

describe('formatReport', () => {
	it('prints scorer reasons for failures, not just numbers', async () => {
		// A CI log that says "0.62" sends someone back to reproduce it by hand.
		const report = await runExperiment({
			name: 'demo',
			cases: [{ name: 'bad', input: null, expectedTools: ['read', 'edit'] }],
			scorers: [trajectoryScorer()],
			run: async () => run({ toolCalls: ['bash'] }),
		})

		const text = formatReport(report)
		expect(text).toContain('0/1 passed')
		expect(text).toContain('✗ bad')
		expect(text).toContain('trajectory:')
		expect(text).toContain('expected read → edit')
	})
})
