import { describe, expect, it } from 'vitest'

import { runExperiment } from '../experiment.js'
import { containsScorer, stepBudgetScorer, trajectoryScorer } from '../scorers.js'
import type { EvalRun } from '../types.js'

/**
 * An eval harness that reports green on a broken suite is worse than no
 * harness: it converts "we do not know" into "we checked". Both defects
 * here did exactly that.
 */

const emptyRun = (): EvalRun => ({
	output: 'ok',
	steps: [],
	toolCalls: [],
	totalTokens: 0,
	totalCostUsd: 0,
	durationMs: 0,
})

describe('a case whose run THREW cannot score above zero', () => {
	it('scores 0 instead of a perfect step budget', async () => {
		// `executeCase` catches the throw and returns an empty run, and an
		// empty run walks into every scorer's happy path: 0 steps is within
		// any allowance, and "no tools expected, none called" is a match. The
		// suite reported 1.0 for a case that never ran.
		const report = await runExperiment({
			name: 'crash',
			cases: [{ name: 'boom', input: 'x' }],
			scorers: [stepBudgetScorer(5), trajectoryScorer()],
			run: () => {
				throw new Error('provider exploded')
			},
		})

		expect(report.cases[0]?.scores['step-budget']?.score).toBe(0)
		expect(report.cases[0]?.scores.trajectory?.score).toBe(0)
		expect(report.mean).toBe(0)
	})

	it('says why, so the green-to-red change is diagnosable', async () => {
		const report = await runExperiment({
			name: 'crash',
			cases: [{ name: 'boom', input: 'x' }],
			scorers: [stepBudgetScorer(5)],
			run: () => {
				throw new Error('provider exploded')
			},
		})

		expect(report.cases[0]?.scores['step-budget']?.reason).toContain('provider exploded')
	})

	it('still scores a healthy run normally', async () => {
		const report = await runExperiment({
			name: 'fine',
			cases: [{ name: 'ok', input: 'x' }],
			scorers: [stepBudgetScorer(5)],
			run: () => Promise.resolve(emptyRun()),
		})

		expect(report.cases[0]?.scores['step-budget']?.score).toBe(1)
	})
})

describe('two scorers cannot silently collapse into one', () => {
	it('refuses a duplicate scorer name rather than overwriting', async () => {
		// Scores are keyed by name, so two `containsScorer(...)` instances —
		// both called 'contains' — meant the second overwrote the first and
		// the case mean was computed over the wrong denominator. With 'a'
		// scoring 0 and 'b' scoring 1 the suite reported 1.0 where the honest
		// answer is 0.5.
		await expect(
			runExperiment({
				name: 'dupe',
				cases: [{ name: 'c', input: 'x' }],
				scorers: [containsScorer('a'), containsScorer('b')],
				run: () => Promise.resolve({ ...emptyRun(), output: 'b' }),
			}),
		).rejects.toThrow(/Duplicate scorer name "contains"/)
	})

	it('accepts distinct names', async () => {
		const report = await runExperiment({
			name: 'ok',
			cases: [{ name: 'c', input: 'x' }],
			scorers: [
				{ ...containsScorer('a'), name: 'contains-a' },
				{ ...containsScorer('b'), name: 'contains-b' },
			],
			run: () => Promise.resolve({ ...emptyRun(), output: 'b' }),
		})

		expect(report.cases[0]?.scores['contains-a']?.score).toBe(0)
		expect(report.cases[0]?.scores['contains-b']?.score).toBe(1)
		expect(report.cases[0]?.mean).toBe(0.5)
	})
})
