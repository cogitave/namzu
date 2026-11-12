import { describe, expect, it } from 'vitest'

import { formatReport, runExperiment } from '../experiment.js'
import { withEvalRunOptions } from '../run-options.js'
import { summarizeRun } from '../run-summary.js'
import { customScorer } from '../scorers.js'
import type { EvalCase, EvalTurn } from '../types.js'

function turn(overrides: Partial<EvalTurn> = {}): EvalTurn {
	return {
		output: 'done',
		steps: [],
		toolCalls: [],
		totalTokens: 0,
		totalCostUsd: 0,
		durationMs: 0,
		...overrides,
	}
}

/** Passes when the case's `expected` says to, on this repeat (1-based). */
const passes = customScorer('passes', (t) => ({
	score: t.output === 'pass' ? 1 : 0,
	reason: t.output === 'pass' ? 'ok' : 'the script said fail',
}))

/**
 * `script[name]` is the list of outputs for that case's repeats, in order.
 * Calls are counted per case, so the script holds however the runs interleave.
 */
function scripted(script: Record<string, string[]>) {
	const calls: Record<string, number> = {}
	return async (_input: unknown, c: EvalCase): Promise<EvalTurn> => {
		const n = calls[c.name] ?? 0
		calls[c.name] = n + 1
		return turn({ output: (script[c.name] as string[])[n] ?? 'fail' })
	}
}

const names = ['a', 'b', 'c', 'd', 'e', 'f']
const cases = (split?: EvalCase['split']): EvalCase[] =>
	names.map((name) => ({ name, input: null, ...(split ? { split } : {}) }))

describe('repeats', () => {
	it('runs every case once by default and keeps the report in its old shape plus optional fields', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			scorers: [passes],
			run: scripted(Object.fromEntries(names.map((n) => [n, ['pass']]))),
		})
		expect(report.cases).toHaveLength(6)
		expect(report.passed).toBe(6)
		expect(report.repeats).toBe(1)
		expect(report.caseSummaries).toBeUndefined()
		expect(report.reliability).toBeUndefined()
		expect(report.passRate).toBe(1)
		expect(report.intervals?.mean).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
		expect(report.seed).toBe(1)
	})

	it('runs every case N times and says per case how many passed', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			repeats: 3,
			scorers: [passes],
			run: scripted({
				a: ['pass', 'pass', 'pass'],
				b: ['pass', 'fail', 'pass'],
				c: ['fail', 'fail', 'fail'],
				d: ['pass', 'pass', 'pass'],
				e: ['pass', 'pass', 'pass'],
				f: ['fail', 'pass', 'fail'],
			}),
		})
		expect(report.repeats).toBe(3)
		// Every run is kept, case-major, each marked with its repeat.
		expect(report.cases.map((c) => `${c.case}${c.repeat}`)).toEqual(
			names.flatMap((n) => [1, 2, 3].map((r) => `${n}${r}`)),
		)
		expect(report.passed).toBe(12)
		expect(report.failed).toBe(6)
		const byCase = Object.fromEntries((report.caseSummaries ?? []).map((c) => [c.case, c.passed]))
		expect(byCase).toEqual({ a: 3, b: 2, c: 0, d: 3, e: 3, f: 1 })
		// 12 of 18 runs; 3 of 6 cases passed every time.
		expect(report.passRate).toBeCloseTo(12 / 18, 12)
		expect(report.reliability).toEqual({ cases: 6, passedEveryRepeat: 3, fraction: 0.5 })
		expect(report.intervals?.method.cases).toBe(6)
	})

	it('names the two rates plainly in the summary', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			repeats: 2,
			scorers: [passes],
			run: scripted({ a: ['pass', 'fail'], b: ['pass', 'pass'] }),
		})
		const text = formatReport(report)
		expect(text).toContain('runs passed (6 cases x 2 repeats')
		expect(text).toContain(
			'reliability across repeats: 1 of 6 cases passed in every one of 2 repeats',
		)
		expect(text).toContain('a: 1 of 2 passed')
		expect(text).toContain('[repeat 2 of 2]')
	})

	it('takes the count from the run scope, which wins over the config', async () => {
		const report = await withEvalRunOptions({ repeats: 2, seed: 9 }, () =>
			runExperiment({
				name: 's',
				cases: cases(),
				repeats: 1,
				scorers: [passes],
				run: scripted({}),
			}),
		)
		expect(report.repeats).toBe(2)
		expect(report.seed).toBe(9)
		expect(report.cases).toHaveLength(12)
		expect(report.intervals?.method.seed).toBe(9)
	})

	it('rejects a repeat count or seed that cannot be used', async () => {
		const base = { name: 's', cases: cases(), scorers: [passes], run: scripted({}) }
		await expect(runExperiment({ ...base, repeats: 0 })).rejects.toThrow(RangeError)
		await expect(runExperiment({ ...base, repeats: 1.5 })).rejects.toThrow(RangeError)
		await expect(runExperiment({ ...base, repeats: 101 })).rejects.toThrow(RangeError)
		await expect(runExperiment({ ...base, seed: -3 })).rejects.toThrow(RangeError)
	})

	it('gives the same intervals for the same seed and different ones for another', async () => {
		const run = async (seed: number) =>
			(
				await runExperiment({
					name: 's',
					cases: cases(),
					seed,
					scorers: [passes],
					run: scripted({ a: ['pass'], b: ['pass'], c: ['pass'] }),
				})
			).intervals
		expect(await run(4)).toEqual(await run(4))
		expect(await run(4)).not.toEqual(await run(5))
	})
})

describe('splits', () => {
	it('reports each split and says when none is held out', async () => {
		const report = await runExperiment({
			name: 's',
			cases: [
				{ name: 'a', input: null, split: 'development' },
				{ name: 'b', input: null, split: 'development' },
				{ name: 'c', input: null, split: 'held-out' },
				{ name: 'd', input: null },
			],
			scorers: [passes],
			run: scripted({ a: ['pass'], b: ['fail'], c: ['pass'], d: ['pass'] }),
		})
		expect(report.splits?.development).toMatchObject({
			cases: 2,
			runs: 2,
			passed: 1,
			failed: 1,
			passRate: 0.5,
		})
		expect(report.splits?.['held-out']).toMatchObject({ cases: 1, passed: 1, passRate: 1 })
		expect(report.splits?.unassigned).toMatchObject({ cases: 1 })
		expect(report.cases.find((c) => c.case === 'c')?.split).toBe('held-out')
		expect(formatReport(report)).not.toContain('no held-out cases')
	})

	it('says so when a suite has no held-out cases, and needs no split to be declared', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			scorers: [passes],
			run: scripted({}),
		})
		expect(Object.keys(report.splits ?? {})).toEqual(['unassigned'])
		expect(formatReport(report)).toContain('no held-out cases')
	})

	it('refuses a split that is not one of the two', async () => {
		await expect(
			runExperiment({
				name: 's',
				cases: [{ name: 'a', input: null, split: 'test' as never }],
				scorers: [passes],
				run: scripted({}),
			}),
		).rejects.toThrow(/declares split "test"/)
	})
})

describe('disclosure', () => {
	it('writes what the suite declared and unknown for the rest, never a guess', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			scorers: [passes],
			run: scripted({}),
			disclosure: { mode: 'scripted', roles: { agent: { provider: 'mock', model: 'script' } } },
		})
		expect(report.disclosure).toMatchObject({
			mode: 'scripted',
			roles: { agent: { provider: 'mock', model: 'script' } },
			routing: 'unknown',
			reasoningEffort: 'unknown',
			suiteVersion: 'unknown',
			harnessVersion: 'unknown',
			commit: 'unknown',
			cases: 6,
			repeats: 1,
			seed: 1,
		})
		expect(report.disclosure?.sdkVersion).toMatch(/^\d+\.\d+\.\d+/)
		expect(Number.isNaN(Date.parse(report.disclosure?.generatedAt ?? ''))).toBe(false)
	})

	it('says everything is unknown when the suite declares nothing', async () => {
		const report = await runExperiment({
			name: 's',
			cases: cases(),
			scorers: [passes],
			run: scripted({}),
		})
		expect(report.disclosure).toMatchObject({ mode: 'unknown', roles: 'unknown' })
		expect(formatReport(report)).toContain('ran as unknown: models unknown')
	})

	it('takes the harness version, commit and suite version from the run scope', async () => {
		const report = await withEvalRunOptions(
			{ harnessVersion: '9.9.9', commit: 'abc123', suiteVersion: '2.0.0' },
			() => runExperiment({ name: 's', cases: cases(), scorers: [passes], run: scripted({}) }),
		)
		expect(report.disclosure).toMatchObject({
			harnessVersion: '9.9.9',
			commit: 'abc123',
			suiteVersion: '2.0.0',
		})
	})
})

describe('case names', () => {
	it('a suite that names two cases alike is refused, because their numbers would merge', async () => {
		await expect(
			runExperiment({
				name: 'dup',
				cases: [
					{ name: 'a', input: null },
					{ name: 'a', input: null },
				],
				scorers: [passes],
				run: scripted({ a: ['pass'] }),
			}),
		).rejects.toThrow(/"a".*more than once/)
	})
})

describe('the whole-run mode', () => {
	const entry = (suite: string, mode: 'scripted' | 'no-model' | 'real-model') =>
		({ suite, report: { name: suite, cases: [], disclosure: { mode } } }) as never
	const context = {
		seed: 1,
		harnessVersion: 'h',
		sdkVersion: 's',
		commit: 'c',
		generatedAt: 'now',
	}

	it('does not call scripted plus no-model mixed: no real model ran', () => {
		const summary = summarizeRun([entry('a', 'scripted'), entry('b', 'no-model')], context)
		expect(summary.disclosure.mode).toBe('scripted')
	})

	it('says no-model when none used a model, and mixed when models differ in kind', () => {
		expect(summarizeRun([entry('a', 'no-model')], context).disclosure.mode).toBe('no-model')
		expect(
			summarizeRun([entry('a', 'scripted'), entry('b', 'real-model')], context).disclosure.mode,
		).toBe('mixed')
	})
})
