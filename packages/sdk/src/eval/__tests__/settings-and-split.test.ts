import { describe, expect, it } from 'vitest'

import { compareEvalReports, formatEvalComparison, loadEvalReportFile } from '../compare.js'
import { runExperiment } from '../experiment.js'
import { currentEvalSettings, evalSetting, withEvalRunOptions } from '../run-options.js'
import { summarizeRun } from '../run-summary.js'
import { customScorer } from '../scorers.js'
import {
	DEFAULT_SETTINGS_NAME,
	buildSettingsSnapshot,
	canonicalJson,
	defaultSettingsSnapshot,
	diffSettings,
	findSecretIn,
} from '../settings.js'
import { HELD_OUT_FRACTION, TASK_SPLIT_SEED, assignSplit, hashedSplit } from '../split.js'
import type { EvalCase, EvalTurn } from '../types.js'

const turn: EvalTurn = {
	output: 'pass',
	steps: [],
	toolCalls: [],
	totalTokens: 0,
	totalCostUsd: 0,
	durationMs: 0,
}
const ok = customScorer('ok', () => ({ score: 1, reason: 'ok' }))

describe('the split of a task', () => {
	// Written out by hand from the seed and share below. If this table has to
	// change, every report ever written has its tasks in other splits: that is
	// a break, not a refactor.
	const TABLE: ReadonlyArray<readonly [string, string, 'tune' | 'held-out']> = [
		['kernel/context', 'a run that outgrows its window still finishes', 'held-out'],
		['kernel/context', 'after a compaction the summary says how to carry on', 'held-out'],
		['kernel/tool-loop', 'alpha', 'tune'],
		['kernel/tool-loop', 'beta', 'tune'],
		['suite/x', 'one', 'held-out'],
		['suite/x', 'two', 'held-out'],
		['suite/x', 'three', 'held-out'],
		['suite/x', 'four', 'held-out'],
		['suite/x', 'five', 'held-out'],
		['suite/x', 'six', 'tune'],
		['suite/x', 'seven', 'tune'],
		['suite/x', 'eight', 'tune'],
	]

	it('is the same on every machine: a fixed table of ids to splits', () => {
		expect(TASK_SPLIT_SEED).toBe('namzu-eval-split-1')
		expect(HELD_OUT_FRACTION).toBe(0.5)
		for (const [suite, name, split] of TABLE) {
			expect(hashedSplit(suite, name), `${suite} / ${name}`).toBe(split)
		}
	})

	it('depends on the suite as well as the case name', () => {
		const moved = TABLE.filter(([, name, split]) => hashedSplit('another/suite', name) !== split)
		expect(moved.length).toBeGreaterThan(0)
	})

	it('lets a suite state it, and the statement wins over the hash', () => {
		// 'alpha' hashes to tune; 'one' hashes to held-out.
		expect(assignSplit('kernel/tool-loop', 'alpha')).toEqual({ split: 'tune', declared: false })
		expect(assignSplit('kernel/tool-loop', 'alpha', 'held-out')).toEqual({
			split: 'held-out',
			declared: true,
		})
		expect(assignSplit('suite/x', 'one', 'development')).toEqual({ split: 'tune', declared: true })
	})
})

describe('a run under a split', () => {
	const cases: EvalCase[] = ['one', 'two', 'six', 'seven', 'eight'].map((name) => ({
		name,
		input: null,
	}))
	const experiment = (extra: Partial<Parameters<typeof runExperiment>[0]> = {}) =>
		runExperiment({ name: 'suite/x', cases, scorers: [ok], run: async () => turn, ...extra })

	it('runs every task by default and records the split and the ids', async () => {
		const report = await experiment()
		expect(report.cases.map((c) => c.case)).toEqual(['one', 'two', 'six', 'seven', 'eight'])
		expect(report.taskSplit).toEqual({
			requested: 'all',
			seed: 'namzu-eval-split-1',
			heldOutFraction: 0.5,
			tasks: [
				{ id: 'suite/x/one', split: 'held-out', declared: false },
				{ id: 'suite/x/two', split: 'held-out', declared: false },
				{ id: 'suite/x/six', split: 'tune', declared: false },
				{ id: 'suite/x/seven', split: 'tune', declared: false },
				{ id: 'suite/x/eight', split: 'tune', declared: false },
			],
		})
	})

	it('runs one split and only that one', async () => {
		const held = await withEvalRunOptions({ split: 'held-out' }, () => experiment())
		expect(held.cases.map((c) => c.case)).toEqual(['one', 'two'])
		expect(held.taskSplit?.requested).toBe('held-out')
		expect(held.taskSplit?.tasks.map((t) => t.id)).toEqual(['suite/x/one', 'suite/x/two'])
		expect(held.disclosure?.cases).toBe(2)
		const tune = await withEvalRunOptions({ split: 'tune' }, () => experiment())
		expect(tune.cases.map((c) => c.case)).toEqual(['six', 'seven', 'eight'])
	})

	it('moves nothing else: the numbers of the default run are the numbers it had', async () => {
		const all = await experiment()
		const held = await withEvalRunOptions({ split: 'held-out' }, () => experiment())
		const tune = await withEvalRunOptions({ split: 'tune' }, () => experiment())
		expect(all.passed).toBe(held.passed + tune.passed)
		expect(all.mean).toBe(1)
		expect(all.intervals).toBeDefined()
	})

	it('honours a case that states its split', async () => {
		const report = await withEvalRunOptions({ split: 'tune' }, () =>
			experiment({
				cases: [{ name: 'one', input: null, split: 'development' }, ...cases.slice(1)],
			}),
		)
		expect(report.cases.map((c) => c.case)).toContain('one')
		expect(report.taskSplit?.tasks[0]).toEqual({ id: 'suite/x/one', split: 'tune', declared: true })
	})

	it('says plainly when no task falls in the split', async () => {
		const report = await withEvalRunOptions({ split: 'tune' }, () =>
			experiment({ cases: [cases[0] as EvalCase] }),
		)
		expect(report.cases).toEqual([])
		expect(report.taskSplit?.tasks).toEqual([])
	})

	it('refuses a split that is not one', async () => {
		await expect(withEvalRunOptions({ split: 'dev' as never }, () => experiment())).rejects.toThrow(
			/split must be/,
		)
	})
})

describe('a settings snapshot', () => {
	it('has the same digest whatever order the keys were written in, and another when a value changes', () => {
		const a = buildSettingsSnapshot('a', {
			limits: { maxIterations: 4, doneGate: false },
			smallModel: 'p/m',
		})
		const b = buildSettingsSnapshot('b', {
			smallModel: 'p/m',
			limits: { doneGate: false, maxIterations: 4 },
		})
		const c = buildSettingsSnapshot('c', {
			smallModel: 'p/m',
			limits: { doneGate: false, maxIterations: 5 },
		})
		expect(a.digest).toBe(b.digest)
		expect(c.digest).not.toBe(a.digest)
		expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
		// The name is a label and is not in the digest.
		expect(a.name).not.toBe(b.name)
	})

	it('has a digest worked out by hand for a small value', () => {
		expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}')
		expect(defaultSettingsSnapshot().digest).toBe(
			'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
		)
	})

	it('keeps list order, which is part of a setting', () => {
		expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }))
	})

	it('is called default only when it states nothing', () => {
		expect(defaultSettingsSnapshot().name).toBe(DEFAULT_SETTINGS_NAME)
		expect(() => buildSettingsSnapshot('default', { limits: { maxIterations: 2 } })).toThrow(
			/for a run with no settings/,
		)
	})

	it('refuses a name that is not plain and a value JSON cannot carry', () => {
		expect(() => buildSettingsSnapshot('has space', {})).toThrow(/settings name/)
		expect(() => buildSettingsSnapshot('x', { n: Number.NaN })).toThrow(/finite/)
	})

	it('never holds a secret: it refuses one by its name and by its shape, naming where and not what', () => {
		const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
		for (const values of [
			{ routing: { apiKey: 'x' } },
			{ hooks: { authorization: 'x' } },
			{ x: { clientSecret: 'x' } },
			{ x: { accessToken: 'x' } },
			{ smallModel: key },
			{ x: [`Bearer ${'a'.repeat(30)}`] },
			{ x: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
		]) {
			expect(() => buildSettingsSnapshot('s', values)).toThrow(/credential/)
		}
		try {
			buildSettingsSnapshot('s', { smallModel: key })
		} catch (err) {
			expect(String(err)).toContain('smallModel')
			expect(String(err)).not.toContain(key)
		}
	})

	it('does not mistake a token limit for a token', () => {
		expect(
			findSecretIn({ limits: { maxResponseTokens: 100, tokenBudget: 5, maxReasoningTokens: 1 } }),
		).toBeUndefined()
	})

	it('says what differs key by key', () => {
		expect(
			diffSettings(
				{ limits: { maxIterations: 4, doneGate: true }, smallModel: 'p/m' },
				{ limits: { maxIterations: 6, doneGate: true }, goal: { confirmedBy: 'record' } },
			),
		).toEqual([
			{ key: 'goal.confirmedBy', b: 'record' },
			{ key: 'limits.maxIterations', a: 4, b: 6 },
			{ key: 'smallModel', a: 'p/m' },
		])
	})
})

describe('a report carries its settings', () => {
	const cases: EvalCase[] = [{ name: 'one', input: null }]
	const experiment = () =>
		runExperiment({
			name: 'suite/x',
			cases,
			scorers: [ok],
			run: async () => {
				currentEvalSettings()
				return turn
			},
		})

	it('names default and holds no values when none were given', async () => {
		const report = await experiment()
		expect(report.settings).toMatchObject({ name: 'default', values: {}, read: false })
		expect(report.settings?.digest).toBe(defaultSettingsSnapshot().digest)
	})

	it('says whether the suite read them, and a suite sees only what was stated', async () => {
		const settings = buildSettingsSnapshot('quick', { limits: { maxIterations: 3 } })
		const settingsUse = { read: false }
		const report = await withEvalRunOptions({ settings, settingsUse }, () => experiment())
		expect(report.settings).toMatchObject({ name: 'quick', digest: settings.digest, read: true })
		const seen = await withEvalRunOptions({ settings }, async () => [
			evalSetting('limits.maxIterations'),
			evalSetting('limits.doneGate'),
			evalSetting('nothing.here'),
		])
		expect(seen).toEqual([3, undefined, undefined])
	})

	it('writes no secret into the report, whatever the suite or the machine holds', async () => {
		const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
		const previous = process.env.NAMZU_TEST_KEY
		process.env.NAMZU_TEST_KEY = secret
		try {
			const settings = buildSettingsSnapshot('quick', { limits: { maxIterations: 3 } })
			const report = await withEvalRunOptions({ settings }, () => experiment())
			const run = summarizeRun([{ suite: 'suite/x', report }], {
				seed: 1,
				harnessVersion: 'x',
				sdkVersion: 'x',
				commit: 'x',
				generatedAt: 'x',
				settings,
				split: 'all',
			})
			const text = JSON.stringify({ run, suites: [{ suite: 'suite/x', report }] })
			expect(text).not.toContain(secret)
			expect(text).toContain('"quick"')
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, 'NAMZU_TEST_KEY')
			else process.env.NAMZU_TEST_KEY = previous
		}
	})
})

describe('a comparison of two settings', () => {
	type Status = 'passed' | 'failed'
	const run = (name: string, status: Status) => ({
		case: name,
		mean: status === 'passed' ? 1 : 0,
		status,
		passed: status === 'passed',
		scores: {},
		turn: {},
	})
	const names = ['a', 'b', 'c', 'd', 'e', 'f']
	/** Six cases, each passing or failing as `pass` says. */
	const report = (
		label: string,
		pass: boolean,
		opts: {
			split?: string
			settings?: {
				name: string
				digest: string
				values: Record<string, unknown>
				read?: boolean
			} | null
			names?: string[]
		} = {},
	) =>
		loadEvalReportFile(
			{
				suites: [
					{
						suite: 's',
						report: {
							name: 's',
							cases: (opts.names ?? names).map((n) => run(n, pass ? 'passed' : 'failed')),
							...(opts.settings === null
								? {}
								: {
										settings: opts.settings ?? {
											name: label,
											digest: `${label}`.padEnd(64, '0'),
											values: { limits: { maxIterations: label === 'a' ? 4 : 6 } },
											read: true,
										},
									}),
							...(opts.split === undefined && opts.settings === null
								? {}
								: { taskSplit: { requested: opts.split ?? 'held-out', tasks: [] } }),
						},
					},
				],
			},
			label,
		)

	it('speaks only on the held-out split, between different settings, over the same tasks', () => {
		const c = compareEvalReports(report('a', false), report('b', true))
		expect(c.verdict.withheld).toEqual([])
		expect(c.verdict.claim).toBe('better')
		expect(c.verdict.sentence).toBe(
			'B is better than A by 1.000 in mean score, 95% interval [1.000, 1.000]',
		)
		expect(c.settings.a).toEqual({ name: 'a', digest: 'a'.padEnd(64, '0') })
		expect(c.settings.identical).toBe(false)
		expect(c.settings.differences).toEqual([{ key: 'limits.maxIterations', a: 4, b: 6 }])
		const text = formatEvalComparison(c)
		expect(text).toContain('Settings: A "a"')
		expect(text).toContain('limits.maxIterations: A 4, B 6')
	})

	it('does not name a winner on the tune split, and says what to do', () => {
		const c = compareEvalReports(
			report('a', false, { split: 'tune' }),
			report('b', true, { split: 'tune' }),
		)
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.withheld).toEqual(['tune-split'])
		expect(c.verdict.sentence).toBe(
			'no winner is named: these are the tasks the settings were chosen on; run the held-out split to judge',
		)
		expect(formatEvalComparison(c)).not.toMatch(/ (better|worse) than /)
		// The numbers are still printed.
		expect(c.difference.mean).toMatchObject({ computed: true, estimate: 1 })
	})

	it('does not name a winner between identical settings: the difference is run-to-run noise', () => {
		const same = { name: 'x', digest: '1'.repeat(64), values: { limits: { maxIterations: 4 } } }
		const c = compareEvalReports(
			report('a', false, { settings: same }),
			report('b', true, { settings: { ...same, name: 'y' } }),
		)
		expect(c.settings.identical).toBe(true)
		expect(c.settings.differences).toEqual([])
		expect(c.verdict.withheld).toEqual(['identical-settings'])
		expect(c.verdict.sentence).toContain('run-to-run noise')
	})

	it('does not name a winner when a report has no snapshot, and still compares', () => {
		const c = compareEvalReports(report('a', false, { settings: null }), report('b', true))
		expect(c.verdict.withheld).toContain('no-snapshot')
		expect(c.verdict.claim).toBe('none')
		expect(c.settings.a).toBeNull()
		expect(c.settings.identical).toBeNull()
		expect(c.paired).toBe(6)
		expect(c.sideB.mean).toBe(1)
		expect(formatEvalComparison(c)).toContain('A none recorded')
	})

	it('does not name a winner over different tasks, and lists them', () => {
		const c = compareEvalReports(
			report('a', false),
			report('b', true, { names: ['a', 'b', 'c', 'd', 'e', 'g'] }),
		)
		expect(c.verdict.withheld).toEqual(['tasks-differ'])
		expect(c.onlyInA).toEqual([{ suite: 's', case: 'f' }])
		expect(c.onlyInB).toEqual([{ suite: 's', case: 'g' }])
		expect(c.verdict.sentence).toContain('different tasks (1 only in A, 1 only in B)')
	})

	it('does not name a winner on all tasks: they include the ones the settings were chosen on', () => {
		const c = compareEvalReports(
			report('a', false, { split: 'all' }),
			report('b', true, { split: 'all' }),
		)
		expect(c.verdict.withheld).toEqual(['not-held-out'])
		expect(c.verdict.claim).toBe('none')
	})

	it('carries the facts as fields', () => {
		const c = JSON.parse(
			JSON.stringify(
				compareEvalReports(
					report('a', false, { split: 'tune' }),
					report('b', true, { split: 'tune' }),
				),
			),
		)
		expect(c.split).toEqual({ a: 'tune', b: 'tune' })
		expect(c.settings.a.name).toBe('a')
		expect(c.settings.differences).toHaveLength(1)
		expect(c.verdict.withheld).toEqual(['tune-split'])
	})

	it('says when a suite ran under settings and never read them', () => {
		const c = compareEvalReports(
			report('a', false, {
				settings: { name: 'a', digest: 'a'.repeat(64), values: { x: 1 }, read: false },
			}),
			report('b', true),
		)
		expect(c.settings.notRead).toEqual({ a: ['s'], b: [] })
		// A snapshot that states nothing was not ignored by anyone.
		const none = compareEvalReports(
			report('a', false, {
				settings: { name: 'default', digest: 'd'.repeat(64), values: {}, read: false },
			}),
			report('b', true),
		)
		expect(none.settings.notRead.a).toEqual([])
		expect(formatEvalComparison(c)).toContain('did not read them (A): s')
	})

	it('still loads a report from before settings and splits', () => {
		const old = loadEvalReportFile(
			{ suites: [{ suite: 's', report: { cases: [run('a', 'passed')] } }] },
			'old',
		)
		expect(old.suites[0]?.settings).toBeUndefined()
		expect(old.suites[0]?.split).toBeUndefined()
	})
})
