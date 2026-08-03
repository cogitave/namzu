import { describe, expect, it } from 'vitest'

import { formatReport, runExperiment } from '../experiment.js'
import type { EvalRun, Score, Scorer } from '../types.js'

/**
 * A case's verdict was one unweighted mean over every scorer against one
 * suite-wide threshold, and the two halves of that fought each other.
 *
 * At the default threshold of 1 the harness never reports a false pass —
 * but a trajectory F1 and a graded judge can essentially never reach 1, so
 * every real suite lowers it. And every step down buys tolerance for the
 * fuzzy scorers by buying exactly the same tolerance for the deterministic
 * ones: at 0.75, a trajectory score of 0 alongside three perfect scores
 * averages to 0.75 and reports PASSED. The regression the harness exists
 * to catch comes back green.
 *
 * The workarounds were lossy too — folding every hard check into one
 * custom scorer destroys per-dimension reporting, and two experiments at
 * two thresholds re-runs the dataset and splits one case's verdict across
 * two reports.
 */

const run = (): EvalRun => ({
	output: 'answer',
	steps: [],
	toolCalls: [],
	totalTokens: 0,
	totalCostUsd: 0,
	durationMs: 0,
})

const scorer = (name: string, score: number, extra: Partial<Scorer> = {}): Scorer => ({
	name,
	score: (): Score => ({ score, reason: `${name} scored ${score}` }),
	...extra,
})

const experiment = (scorers: Scorer[], passThreshold = 0.75) =>
	runExperiment({
		name: 'gates',
		cases: [{ name: 'one', input: null }],
		scorers,
		passThreshold,
		run: async () => run(),
	})

describe('a gate scorer', () => {
	it('fails the case even when the mean clears the threshold', async () => {
		const report = await experiment([
			scorer('trajectory', 0, { severity: 'gate' }),
			scorer('completion', 1),
			scorer('contains', 1),
			scorer('judge', 1),
		])

		// Mean is exactly 0.75 against a 0.75 threshold — reported passed
		// before, with the one deterministic check at zero.
		expect(report.cases[0]?.mean).toBeCloseTo(0.75)
		expect(report.cases[0]?.status).toBe('failed')
	})

	it('names itself, so the reader does not have to guess', async () => {
		const report = await experiment([
			scorer('trajectory', 0, { severity: 'gate' }),
			scorer('judge', 1),
		])
		expect(report.cases[0]?.failedGates).toEqual(['trajectory'])
	})

	it('honours its own threshold when it sets one', async () => {
		// "Good enough" is not one number across dimensions: a trajectory
		// match at 0.8 may be fine while a completion check at 0.8 is
		// meaningless.
		const lenient = await experiment([
			scorer('trajectory', 0.8, { severity: 'gate', threshold: 0.7 }),
		])
		expect(lenient.cases[0]?.status).toBe('passed')

		const strict = await experiment([
			scorer('trajectory', 0.8, { severity: 'gate', threshold: 0.9 }),
		])
		expect(strict.cases[0]?.status).toBe('failed')
	})

	it('falls back to the suite threshold when it sets none', async () => {
		const report = await experiment([scorer('trajectory', 0.5, { severity: 'gate' })], 0.75)
		expect(report.cases[0]?.failedGates).toEqual(['trajectory'])
	})

	it('does not fail the case when it could not judge at all', async () => {
		// Unavailable is not zero. A gate that threw did not judge the run
		// badly, it failed to judge it — the inconclusive path, not a
		// failure, and the two demand opposite responses.
		const report = await runExperiment({
			name: 'gates',
			cases: [{ name: 'one', input: null }],
			scorers: [
				{
					name: 'judge-gate',
					severity: 'gate',
					score: () => {
						throw new Error('provider unreachable')
					},
				},
			],
			run: async () => run(),
		})

		expect(report.cases[0]?.status).toBe('inconclusive')
		expect(report.cases[0]?.failedGates).toBeUndefined()
	})

	it('lets a passing gate through', async () => {
		const report = await experiment([scorer('trajectory', 1, { severity: 'gate' })])
		expect(report.cases[0]?.status).toBe('passed')
	})
})

describe('a soft scorer', () => {
	it('only moves the mean', async () => {
		// The fuzzy dimensions, where a number below 1 is normal and a
		// threshold is a judgement call.
		const report = await experiment([scorer('judge', 0.5), scorer('other', 1)])
		expect(report.cases[0]?.status).toBe('passed')
		expect(report.cases[0]?.failedGates).toBeUndefined()
	})

	it('is the default, so a suite that sets nothing is unchanged', async () => {
		const report = await experiment([
			scorer('a', 0),
			scorer('b', 1),
			scorer('c', 1),
			scorer('d', 1),
		])
		expect(report.cases[0]?.status).toBe('passed')
	})

	it('can still fail the case through the mean', async () => {
		const report = await experiment([scorer('a', 0), scorer('b', 0.5)])
		expect(report.cases[0]?.status).toBe('failed')
		expect(report.cases[0]?.failedGates).toBeUndefined()
	})
})

describe('the report', () => {
	it('says which gate missed, above the individual scores', async () => {
		const report = await experiment([
			scorer('trajectory', 0, { severity: 'gate' }),
			scorer('judge', 1),
		])

		const text = formatReport(report)
		expect(text).toContain('gate missed: trajectory')
	})
})
