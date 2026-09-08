import { describe, expect, it } from 'vitest'
import { runExperiment } from '../experiment.js'
import { compareHarnessTrials, reviewHarnessCandidate } from '../harness-verification.js'
import type {
	HarnessAttribution,
	HarnessTrial,
	HarnessVerificationBatch,
} from '../harness-verification.js'
import type { CaseResult } from '../types.js'

function result(pass: boolean): CaseResult {
	return {
		case: 'fixture',
		status: pass ? 'passed' : 'failed',
		passed: pass,
		mean: Number(pass),
		scores: { exact: { score: Number(pass), reason: 'Deterministic fixture reward' } },
		run: {
			output: null,
			steps: [],
			toolCalls: [],
			totalTokens: 10,
			totalCostUsd: 0.01,
			durationMs: 5,
		},
	}
}

function batch(
	prefix = 'initial',
	patterns = [
		[0, 2],
		[2, 2],
		[2, 2],
		[2, 2],
		[2, 2],
	],
): HarnessVerificationBatch {
	const baseline: HarnessTrial[] = []
	const candidate: HarnessTrial[] = []
	for (const [index, [before, after]] of patterns.entries())
		for (let trial = 0; trial < 2; trial++) {
			const common = {
				taskId: `${prefix}-${index}`,
				trial,
				conditions: `${prefix}-${index}-${trial}`,
			}
			baseline.push({
				...common,
				trajectoryId: `b-${common.conditions}`,
				result: result(trial < before!),
			})
			candidate.push({
				...common,
				trajectoryId: `c-${common.conditions}`,
				result: result(trial < after!),
			})
		}
	return {
		baselineRevision: 'before',
		candidateRevision: 'after',
		baseline,
		candidate,
		attributions: [attribution(baseline, candidate, `${prefix}-0`)],
	}
}

function attribution(
	b: readonly HarnessTrial[],
	c: readonly HarnessTrial[],
	taskId: string,
): HarnessAttribution {
	return {
		taskId,
		effect: 'improvement',
		reason: 'The changed retrieval tool exposed the missing receipt.',
		baselineTrajectories: b.filter((t) => t.taskId === taskId).map((t) => t.trajectoryId),
		candidateTrajectories: c.filter((t) => t.taskId === taskId).map((t) => t.trajectoryId),
	}
}

describe('paired harness verification', () => {
	it('implements all five Table 6 labels without collapsing mixed outcomes into success', () => {
		const report = compareHarnessTrials(
			batch('table', [
				[0, 1],
				[1, 2],
				[1, 0],
				[0, 0],
				[2, 1],
			]),
		)
		expect(report.tasks.map((t) => t.status)).toEqual([
			'recovered',
			'stable-success',
			'regressed',
			'still-failing',
			'mixed',
		])
		expect(report.passRateDelta).toBe(0)
		expect(report.usage).toEqual({
			rollouts: 20,
			tokens: 200,
			costUsd: expect.closeTo(0.2),
			durationMs: 100,
		})
	})
	it('accepts only after a fresh confirmation with trace-linked improvement', () => {
		expect(reviewHarnessCandidate(batch()).decision).toBe('inconclusive')
		expect(reviewHarnessCandidate(batch(), batch('fresh')).decision).toBe('accept')
	})
	it('blocks aggregate improvement without attributable behavior', () => {
		const b = batch()
		b.attributions = []
		expect(compareHarnessTrials(b).passRateDelta).toBeGreaterThan(0)
		expect(reviewHarnessCandidate(b, batch('fresh')).decision).toBe('reject')
	})
	it('does not let gains elsewhere hide even an unattributed regression', () => {
		const b = batch('initial', [
			[0, 2],
			[0, 2],
			[2, 0],
			[2, 2],
			[2, 2],
		])
		expect(compareHarnessTrials(b).passRateDelta).toBeGreaterThan(0)
		expect(reviewHarnessCandidate(b, batch('fresh')).decision).toBe('reject')
	})
	it('blocks behavior regressions even when every binary reward improves or stays stable', () => {
		const b = batch()
		b.attributions = [
			...b.attributions,
			{
				...attribution(b.baseline, b.candidate, 'initial-1'),
				effect: 'regression',
				reason: 'Repeated a state-changing action despite final success.',
			},
		]
		expect(reviewHarnessCandidate(b).decision).toBe('reject')
	})
	it('does not turn unavailable measurements, transport failures or NaN into recoveries', () => {
		for (const fault of ['unavailable', 'error', 'nan'] as const) {
			const b = batch()
			if (fault === 'unavailable') b.baseline[0]!.result.scores.exact!.unavailable = true
			if (fault === 'error') b.baseline[0]!.result.run.error = '429'
			if (fault === 'nan') b.baseline[0]!.result.scores.exact!.score = Number.NaN
			expect(compareHarnessTrials(b).passRateDelta).toBeNull()
			expect(reviewHarnessCandidate(b, batch('fresh')).decision).toBe('inconclusive')
		}
	})
	it('requires real pairs, unique traces and valid evidence links', () => {
		const missing = batch()
		missing.candidate = missing.candidate.slice(1)
		expect(() => compareHarnessTrials(missing)).toThrow(/paired/)
		const mismatch = batch()
		mismatch.candidate[0]!.conditions = 'another model or seed'
		expect(() => compareHarnessTrials(mismatch)).toThrow(/conditions/)
		const duplicate = batch()
		duplicate.baseline = [...duplicate.baseline, duplicate.baseline[0]!]
		expect(() => compareHarnessTrials(duplicate)).toThrow(/Duplicate/)
		const falseTrace = batch()
		falseTrace.attributions[0]!.candidateTrajectories = ['invented']
		expect(() => compareHarnessTrials(falseTrace)).toThrow(/cite/)
		const reused = batch()
		reused.candidate[0]!.trajectoryId = reused.baseline[0]!.trajectoryId
		expect(() => compareHarnessTrials(reused)).toThrow(/distinct trajectories/)
	})
	it('requires a sufficiently broad, same-revision confirmation and fresh conditions', () => {
		expect(reviewHarnessCandidate(batch('small', [[0, 2]])).decision).toBe('inconclusive')
		expect(reviewHarnessCandidate(batch(), batch()).decision).toBe('inconclusive')
		const other = batch('fresh')
		other.candidateRevision = 'different patch'
		expect(reviewHarnessCandidate(batch(), other).decision).toBe('inconclusive')
		const seeds = batch('fresh')
		seeds.baseline[0]!.conditions = seeds.candidate[0]!.conditions = 'initial-0-0'
		expect(reviewHarnessCandidate(batch(), seeds).decision).toBe('inconclusive')
	})
	it('rejects confirmation with only preservation, regardless of reviewer praise', () => {
		expect(
			reviewHarnessCandidate(
				batch(),
				batch(
					'fresh',
					Array.from({ length: 5 }, () => [2, 2]),
				),
			).decision,
		).toBe('reject')
	})
	it('consumes real runExperiment case results and preserves scorer failures as inconclusive', async () => {
		const report = await runExperiment({
			name: 'verification integration',
			cases: [{ name: 'case', input: 1 }],
			run: async () => result(true).run,
			scorers: [
				{
					name: 'offline verifier',
					score: () => {
						throw new Error('verifier unavailable')
					},
				},
			],
		})
		const b = batch()
		b.candidate[0]!.result = report.cases[0]!
		expect(reviewHarnessCandidate(b).decision).toBe('inconclusive')
	})
})
