import { describe, expect, it } from 'vitest'

import { compareEvalReports, formatEvalComparison, loadEvalReportFile } from '../compare.js'

type Status = 'passed' | 'failed' | 'inconclusive'

/** One run of a case: a pass is 1, a fail 0, as a case with one gate would score. */
const run = (name: string, status: Status, repeat?: number) => ({
	case: name,
	mean: status === 'passed' ? 1 : 0,
	status,
	passed: status === 'passed',
	scores: {},
	turn: {},
	...(repeat ? { repeat } : {}),
})

function suite(id: string, runs: ReturnType<typeof run>[], extra: Record<string, unknown> = {}) {
	return { suite: id, report: { name: id, cases: runs, ...extra } }
}

const file = (label: string, ...suites: ReturnType<typeof suite>[]) =>
	loadEvalReportFile({ suites }, label)

const ids = ['a', 'b', 'c', 'd', 'e', 'f']
/** `statuses` in the order of `ids`. */
const side = (statuses: Status[], id = 's') =>
	suite(
		id,
		ids.map((n, i) => run(n, statuses[i] as Status)),
	)

const P: Status = 'passed'
const F: Status = 'failed'

describe('a paired comparison', () => {
	it('with no difference, claims none and says the interval is zero', () => {
		const same = [P, P, F, P, F, P] as Status[]
		const c = compareEvalReports(file('a', side(same)), file('b', side(same)))
		expect(c.paired).toBe(6)
		expect(c.difference.mean).toEqual({ computed: true, estimate: 0, low: 0, high: 0 })
		expect(c.flips).toMatchObject({
			onlyBPasses: 0,
			onlyAPasses: 0,
			bothPass: 4,
			bothFail: 2,
			pValue: 1,
		})
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.sentence).toBe('no difference can be claimed at this size')
	})

	it('with one case different, does not name a winner: the interval includes zero', () => {
		const a = [P, P, F, P, F, P] as Status[]
		const b = [P, P, P, P, F, P] as Status[]
		const c = compareEvalReports(file('a', side(a)), file('b', side(b)))
		expect(c.sideA.mean).toBeCloseTo(4 / 6, 12)
		expect(c.sideB.mean).toBeCloseTo(5 / 6, 12)
		expect(c.difference.mean.estimate).toBeCloseTo(1 / 6, 12)
		expect(c.flips).toMatchObject({ onlyBPasses: 1, onlyAPasses: 0 })
		// One flip: 2 * P(X <= 0) = 2 * (1/2) = 1.
		expect(c.flips.pValue).toBe(1)
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.sentence).toBe('no difference can be claimed at this size')
		expect(c.verdict.detail).toContain('includes zero')
	})

	it('with every case different, says B is better by the difference, with its interval', () => {
		const c = compareEvalReports(
			file('a', side([F, F, F, F, F, F])),
			file('b', side([P, P, P, P, P, P])),
		)
		expect(c.difference.mean).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
		expect(c.flips).toMatchObject({ onlyBPasses: 6, onlyAPasses: 0 })
		// Six flips one way: 2 * (1 / 2^6).
		expect(c.flips.pValue).toBeCloseTo(2 / 64, 12)
		expect(c.verdict.claim).toBe('better')
		expect(c.verdict.sentence).toBe(
			'B is better than A by 1.000 in mean score, 95% interval [1.000, 1.000]',
		)
	})

	it('says worse when the sides are the other way round', () => {
		const c = compareEvalReports(
			file('a', side([P, P, P, P, P, P])),
			file('b', side([F, F, F, F, F, F])),
		)
		expect(c.verdict.claim).toBe('worse')
		expect(c.verdict.sentence).toContain('B is worse than A by 1.000')
		expect(c.flips).toMatchObject({ onlyAPasses: 6, onlyBPasses: 0 })
	})

	it('counts flips both ways and tests them against a value worked out by hand', () => {
		// Ten cases: six go fail -> pass, two go pass -> fail, one passes both, one fails both.
		const names = Array.from({ length: 10 }, (_, i) => `c${i}`)
		const a: Status[] = [F, F, F, F, F, F, P, P, P, F]
		const b: Status[] = [P, P, P, P, P, P, F, F, P, F]
		const mk = (s: Status[]) =>
			suite(
				's',
				names.map((n, i) => run(n, s[i] as Status)),
			)
		const c = compareEvalReports(file('a', mk(a)), file('b', mk(b)))
		expect(c.flips).toMatchObject({ onlyBPasses: 6, onlyAPasses: 2, bothPass: 1, bothFail: 1 })
		// n = 8 flips, smaller side 2: 2 * (1 + 8 + 28) / 256 = 74 / 256.
		expect(c.flips.pValue).toBeCloseTo(74 / 256, 12)
	})

	it('lists the cases only one side has and pairs the rest by suite and id', () => {
		const a = file(
			'a',
			suite('s', [
				run('a', P),
				run('b', P),
				run('c', F),
				run('d', P),
				run('e', P),
				run('only-a', P),
			]),
			suite('gone', [run('x', P)]),
		)
		const b = file(
			'b',
			suite('s', [
				run('a', P),
				run('b', F),
				run('c', F),
				run('d', P),
				run('e', P),
				run('only-b', F),
			]),
			suite('fresh', [run('y', F)]),
			// The same id in another suite is another case.
		)
		const c = compareEvalReports(a, b)
		expect(c.onlyInA).toEqual([
			{ suite: 'gone', case: 'x' },
			{ suite: 's', case: 'only-a' },
		])
		expect(c.onlyInB).toEqual([
			{ suite: 'fresh', case: 'y' },
			{ suite: 's', case: 'only-b' },
		])
		expect(c.paired).toBe(5)
		expect(c.flips).toMatchObject({ onlyAPasses: 1, onlyBPasses: 0 })
		const text = formatEvalComparison(c)
		expect(text).toContain('Only in A (2):')
		expect(text).toContain('s / only-a')
		expect(text).toContain('fresh / y')
	})

	it('does not use cases that no run judged on one side', () => {
		const a = file('a', side([P, P, P, P, P, P]))
		const b = file('b', side([P, P, P, P, P, 'inconclusive']))
		const c = compareEvalReports(a, b)
		expect(c.paired).toBe(5)
		expect(c.notJudged).toEqual([{ suite: 's', case: 'f' }])
	})

	it('computes no interval and claims nothing below the minimum, and says why', () => {
		const names = ['a', 'b', 'c', 'd']
		const mk = (s: Status) =>
			suite(
				's',
				names.map((n) => run(n, s)),
			)
		const c = compareEvalReports(file('a', mk(F)), file('b', mk(P)))
		expect(c.paired).toBe(4)
		expect(c.difference.mean.computed).toBe(false)
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.detail).toBe('no interval: only 4 paired cases; an interval needs at least 5.')
		// The point difference is still given.
		expect(c.difference.mean.estimate).toBe(1)
	})

	it('reads repeats: a case passes only if every one of its runs passed', () => {
		const rep = (name: string, outcomes: Status[]) => outcomes.map((s, i) => run(name, s, i + 1))
		const mk = (rows: Record<string, Status[]>, repeats: number) =>
			suite(
				's',
				Object.entries(rows).flatMap(([n, o]) => rep(n, o)),
				{ repeats },
			)
		const a = mk(
			{
				a: [P, P, P],
				b: [P, P, P],
				c: [P, F, P],
				d: [F, F, F],
				e: [P, P, P],
			},
			3,
		)
		const b = mk(
			{
				a: [P, P, F],
				b: [P, P, P],
				c: [P, P, P],
				d: [F, F, F],
				e: [P, P, P],
			},
			3,
		)
		const c = compareEvalReports(file('a', a), file('b', b))
		// a: passed on A, not on B. c: the reverse. b and e: both. d: neither.
		expect(c.flips).toMatchObject({ onlyAPasses: 1, onlyBPasses: 1, bothPass: 2, bothFail: 1 })
		// Pooled over runs: A passes 11 of 15, B 11 of 15, so no difference in the rate.
		expect(c.sideA.passRate).toBeCloseTo(11 / 15, 12)
		expect(c.sideB.passRate).toBeCloseTo(11 / 15, 12)
		expect(c.difference.passRate.estimate).toBeCloseTo(0, 12)
		expect(c.disclosure.differences).toEqual([])
	})

	it('is the same for the same seed and may differ for another', () => {
		const a = file('a', side([P, F, F, P, F, P]))
		const b = file('b', side([P, P, F, P, P, P]))
		expect(compareEvalReports(a, b, { seed: 3 })).toEqual(compareEvalReports(a, b, { seed: 3 }))
		expect(compareEvalReports(a, b, { seed: 3 }).seed).toBe(3)
	})
})

describe('what two reports say about how they were produced', () => {
	const facts = (over: Record<string, unknown> = {}) => ({
		disclosure: {
			harnessVersion: '1.0.0',
			sdkVersion: '2.0.0',
			commit: 'abc',
			mode: 'real-model',
			roles: { agent: { provider: 'p', model: 'm1' } },
			routing: 'off',
			reasoningEffort: 'medium',
			suiteVersion: '1.0.0',
			...over,
		},
	})
	const withFacts = (over: Record<string, unknown> = {}) =>
		suite(
			's',
			ids.map((n) => run(n, P)),
			facts(over),
		)

	it('loads a report from an older version that has no such fields, and says they are not stated', () => {
		const old = file('old', side([P, P, P, P, P, P]))
		const fresh = file('new', withFacts())
		const c = compareEvalReports(old, fresh)
		expect(c.paired).toBe(6)
		expect(c.disclosure.differences).toEqual([])
		expect(c.disclosure.differingDimensions).toEqual([])
		expect(c.disclosure.unknown.map((u) => u.key)).toContain('s models')
		expect(c.disclosure.unknown.every((u) => u.missingIn === 'a')).toBe(true)
		expect(c.disclosure.warning).toBeUndefined()
		// The older file ran every case once, and says so by saying nothing.
		expect(formatEvalComparison(c)).toContain('Stated on one side only')
	})

	it('loads an older file that has a pass flag and no status', () => {
		const loaded = loadEvalReportFile(
			{ suites: [{ suite: 's', report: { cases: [{ case: 'a', mean: 1, passed: true }] } }] },
			'old',
		)
		expect(loaded.suites[0]?.cases[0]?.runs).toHaveLength(1)
	})

	it('names one differing thing without a warning', () => {
		const c = compareEvalReports(
			file('a', withFacts()),
			file('b', withFacts({ roles: { agent: { provider: 'p', model: 'm2' } } })),
		)
		expect(c.disclosure.differingDimensions).toEqual(['model'])
		expect(c.disclosure.differences).toEqual([
			{ dimension: 'model', key: 's models', a: 'agent=p/m1', b: 'agent=p/m2' },
		])
		expect(c.disclosure.warning).toBeUndefined()
	})

	it('warns when more than one thing differs, because the difference cannot be attributed', () => {
		const c = compareEvalReports(
			file('a', withFacts()),
			file(
				'b',
				withFacts({
					roles: { agent: { provider: 'p', model: 'm2' } },
					reasoningEffort: 'high',
					harnessVersion: '1.1.0',
				}),
			),
		)
		expect(c.disclosure.differingDimensions).toEqual(['harness', 'model', 'effort'])
		expect(c.disclosure.warning).toContain('harness, model, effort')
		expect(c.disclosure.warning).toContain('cannot be attributed')
		expect(formatEvalComparison(c)).toContain('Warning:')
	})

	it('sees a change of route and of repeats', () => {
		const changed = suite(
			's',
			ids.map((n) => run(n, P)),
			{ ...facts({ routing: { policy: 'cheap-first' } }), repeats: 3 },
		)
		const c = compareEvalReports(file('a', withFacts({ routing: 'off' })), file('b', changed))
		expect(c.disclosure.differingDimensions).toEqual(['route', 'repeats'])
	})

	it('does not read a model it was told is unknown as a difference', () => {
		const c = compareEvalReports(
			file('a', withFacts({ roles: { agent: { provider: 'p', model: 'unknown' } } })),
			file('b', withFacts({ roles: { agent: { provider: 'p', model: 'm2' } } })),
		)
		expect(c.disclosure.differences).toEqual([])
		expect(c.disclosure.unknown.some((u) => u.key === 's models' && u.missingIn === 'a')).toBe(true)
	})
})

describe('loading a report file', () => {
	it('says what is wrong with a file that is not a report', () => {
		expect(() => loadEvalReportFile({}, 'x.json')).toThrow('x.json is not an eval report')
		expect(() => loadEvalReportFile({ suites: [{ suite: 's', report: {} }] }, 'x.json')).toThrow(
			'suite "s" has no "cases" list',
		)
		expect(() =>
			loadEvalReportFile(
				{ suites: [{ suite: 's', report: { cases: [{ case: 'a' }] } }] },
				'x.json',
			),
		).toThrow('needs a name in "case" and a finite number in "mean"')
	})
})

describe('a claim needs more than a bootstrap bound just off zero', () => {
	const scored = (name: string, mean: number, repeat: number) => ({
		...run(name, 'passed', repeat),
		mean,
	})

	it('names no winner for the same scores in a different order, whatever the float sums do', () => {
		const mk = (order: number[]) =>
			suite(
				's',
				ids.flatMap((n) => order.map((m, i) => scored(n, m, i + 1))),
				{ repeats: 3 },
			)
		const c = compareEvalReports(file('a', mk([0.1, 0.2, 0.3])), file('b', mk([0.3, 0.2, 0.1])))
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.sentence).toBe('no difference can be claimed at this size')
	})

	it('names no winner whose size would print as 0.000', () => {
		const mk = (delta: number) =>
			suite(
				's',
				ids.map((n) => ({ ...run(n, 'passed'), mean: 0.5 + delta })),
			)
		const c = compareEvalReports(file('a', mk(0)), file('b', mk(0.0001)))
		expect(c.verdict.claim).toBe('none')
	})

	it('names no winner when the sign test on the flips disagrees: 5 flips one way and none the other', () => {
		const many = (b: Status) =>
			suite(
				's',
				Array.from({ length: 30 }, (_, i) => run(`c${i}`, i < 5 ? b : P)),
			)
		const c = compareEvalReports(file('a', many(F)), file('b', many(P)))
		expect(c.flips).toMatchObject({ onlyBPasses: 5, onlyAPasses: 0 })
		expect(c.flips.pValue).toBeCloseTo(0.0625, 12)
		expect(c.difference.mean.computed && c.difference.mean.low > 0).toBe(true)
		expect(c.verdict.claim).toBe('none')
		expect(c.verdict.detail).toContain('0.0625')
	})

	it('names no winner for 5 pairs that all flipped', () => {
		const five = (s: Status) =>
			suite(
				's',
				ids.slice(0, 5).map((n) => run(n, s)),
			)
		const c = compareEvalReports(file('a', five(P)), file('b', five(F)))
		expect(c.flips.pValue).toBeCloseTo(0.0625, 12)
		expect(c.verdict.claim).toBe('none')
	})
})

describe('duplicate case ids', () => {
	it('are refused when a report is loaded, naming the suite and the case', () => {
		const dup = suite('s', [run('a', 'passed'), run('a', 'failed'), run('b', 'passed')])
		expect(() => file('x', dup)).toThrow(/suite "s".*"a".*more than once/)
	})

	it('are fine as repeats of one case when each run says which repeat it is', () => {
		const ok = suite('s', [run('a', 'passed', 1), run('a', 'failed', 2)], { repeats: 2 })
		expect(file('x', ok).suites[0]?.cases).toHaveLength(1)
	})
})

describe('a mean that is not a finite number', () => {
	it('is refused when a report is loaded (a file reading 1e999 parses to Infinity)', () => {
		const bad = {
			suites: [{ suite: 's', report: { cases: [{ case: 'a', mean: Number.POSITIVE_INFINITY }] } }],
		}
		expect(() => loadEvalReportFile(bad, 'x')).toThrow(/finite/)
	})
})
