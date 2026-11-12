import { describe, expect, it } from 'vitest'

import {
	BOOTSTRAP_RESAMPLES,
	type CaseTally,
	DEFAULT_EVAL_SEED,
	MIN_CASES_FOR_INTERVAL,
	bootstrapCases,
	bootstrapPairedDifference,
	createSeededRandom,
	exactSignTestP,
	validateSeed,
} from '../bootstrap.js'

/** `n` cases, each judged once, scoring `score` and passing when it is 1. */
const cases = (n: number, score: number): CaseTally[] =>
	Array.from({ length: n }, () => ({ scoreSum: score, passes: score === 1 ? 1 : 0, judged: 1 }))

/** Ten cases, half of them passing, so the interval has something to cover. */
const half = (): CaseTally[] => [...cases(5, 1), ...cases(5, 0)]

describe('the bootstrap over cases', () => {
	it('is exactly 1 when every case passes, because nothing can be resampled into a failure', () => {
		const { mean, passRate } = bootstrapCases(cases(6, 1), 1)
		expect(mean).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
		expect(passRate).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
	})

	it('is exactly 0 when every case fails', () => {
		const { mean, passRate } = bootstrapCases(cases(6, 0), 1)
		expect(mean).toEqual({ computed: true, estimate: 0, low: 0, high: 0 })
		expect(passRate).toEqual({ computed: true, estimate: 0, low: 0, high: 0 })
	})

	it('computes no interval for one case, gives the number, and says why', () => {
		const { mean, passRate, method } = bootstrapCases(cases(1, 1), 1)
		expect(mean.computed).toBe(false)
		expect(mean.estimate).toBe(1)
		expect(passRate.computed).toBe(false)
		if (!mean.computed)
			expect(mean.reason).toBe('only 1 case with a judged run; an interval needs at least 5')
		expect(method.cases).toBe(1)
	})

	it('computes no interval for no cases, and has no estimate either', () => {
		const { mean } = bootstrapCases([], 1)
		expect(mean).toEqual({
			computed: false,
			estimate: null,
			reason: 'only 0 cases with a judged run; an interval needs at least 5',
		})
	})

	it('draws the line at the stated minimum: one below has none, the minimum has one', () => {
		expect(MIN_CASES_FOR_INTERVAL).toBe(5)
		const below = bootstrapCases(half().slice(3, 3 + MIN_CASES_FOR_INTERVAL - 1), 1)
		expect(below.mean.computed).toBe(false)
		const at = bootstrapCases(half().slice(3, 3 + MIN_CASES_FOR_INTERVAL), 1)
		expect(at.mean.computed).toBe(true)
	})

	it('puts the point value inside an interval that stays inside the score range', () => {
		const { mean, passRate, method } = bootstrapCases(half(), 1)
		expect(method).toMatchObject({
			level: 0.95,
			resamples: BOOTSTRAP_RESAMPLES,
			seed: 1,
			cases: 10,
		})
		for (const interval of [mean, passRate]) {
			expect(interval.computed).toBe(true)
			if (!interval.computed) continue
			expect(interval.estimate).toBe(0.5)
			expect(interval.low).toBeGreaterThanOrEqual(0)
			expect(interval.low).toBeLessThan(0.5)
			expect(interval.high).toBeGreaterThan(0.5)
			expect(interval.high).toBeLessThanOrEqual(1)
		}
	})

	it('gives the same interval twice for the same seed, and a different one for another seed', () => {
		const varied: CaseTally[] = [0.1, 0.35, 0.4, 0.55, 0.6, 0.72, 0.8, 0.9, 0.95, 1, 0.2, 0.05].map(
			(score) => ({ scoreSum: score, passes: score >= 0.7 ? 1 : 0, judged: 1 }),
		)
		const again = bootstrapCases(varied, 7)
		expect(bootstrapCases(varied, 7)).toEqual(again)
		const other = bootstrapCases(varied, 8)
		expect(other.mean).not.toEqual(again.mean)
		expect(other.method.seed).toBe(8)
	})

	it('treats a case with several repeats as one case, not as several', () => {
		// Five cases, three passing every time and two failing every time. With
		// three repeats each, the pooled numbers must equal the one-run version:
		// the repeats move with their case and add no independent evidence.
		const once: CaseTally[] = [
			...Array.from({ length: 3 }, () => ({ scoreSum: 1, passes: 1, judged: 1 })),
			...Array.from({ length: 2 }, () => ({ scoreSum: 0, passes: 0, judged: 1 })),
		]
		const thrice: CaseTally[] = once.map((t) => ({
			scoreSum: t.scoreSum * 3,
			passes: t.passes * 3,
			judged: 3,
		}))
		expect(bootstrapCases(thrice, 5)).toEqual(bootstrapCases(once, 5))
	})

	it('weights a case by how many of its runs were judged', () => {
		// One case judged four times (all pass), four cases judged once (all fail).
		const mixed: CaseTally[] = [
			{ scoreSum: 4, passes: 4, judged: 4 },
			...Array.from({ length: 4 }, () => ({ scoreSum: 0, passes: 0, judged: 1 })),
		]
		const { passRate } = bootstrapCases(mixed, 1)
		expect(passRate.estimate).toBe(0.5)
	})

	it('refuses a seed that is not a 32-bit unsigned integer', () => {
		expect(validateSeed(undefined)).toBe(DEFAULT_EVAL_SEED)
		expect(validateSeed(0)).toBe(0)
		expect(() => validateSeed(-1)).toThrow(RangeError)
		expect(() => validateSeed(1.5)).toThrow(RangeError)
		expect(() => validateSeed(2 ** 32)).toThrow(RangeError)
		expect(() => bootstrapCases(half(), Number.NaN)).toThrow(RangeError)
	})
})

describe('the seeded generator', () => {
	it('repeats a sequence for a seed and stays in [0, 1)', () => {
		const first = createSeededRandom(42)
		const second = createSeededRandom(42)
		const values = Array.from({ length: 50 }, () => first())
		expect(values).toEqual(Array.from({ length: 50 }, () => second()))
		for (const v of values) {
			expect(v).toBeGreaterThanOrEqual(0)
			expect(v).toBeLessThan(1)
		}
		expect(new Set(values).size).toBe(50)
	})
})

describe('the paired bootstrap', () => {
	const pair = (a: number, b: number) => ({
		a: { scoreSum: a, passes: a === 1 ? 1 : 0, judged: 1 },
		b: { scoreSum: b, passes: b === 1 ? 1 : 0, judged: 1 },
	})

	it('is exactly +1 when every case goes from fail to pass', () => {
		const d = bootstrapPairedDifference(
			Array.from({ length: 6 }, () => pair(0, 1)),
			1,
		)
		expect(d.mean).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
		expect(d.passRate).toEqual({ computed: true, estimate: 1, low: 1, high: 1 })
	})

	it('is exactly 0 when the two sides are the same', () => {
		const d = bootstrapPairedDifference(
			[pair(1, 1), pair(0, 0), pair(1, 1), pair(0, 0), pair(1, 1)],
			1,
		)
		expect(d.mean).toEqual({ computed: true, estimate: 0, low: 0, high: 0 })
	})

	it('has no interval below the minimum and says so', () => {
		const d = bootstrapPairedDifference([pair(0, 1), pair(0, 1)], 1)
		expect(d.mean).toEqual({
			computed: false,
			estimate: 1,
			reason: 'only 2 paired cases; an interval needs at least 5',
		})
	})
})

describe('the exact sign test', () => {
	it('matches values worked out by hand', () => {
		// n flips, k the smaller side: p = 2 * (sum of C(n, i) for i <= k) / 2^n.
		expect(exactSignTestP(5, 0)).toBeCloseTo(2 / 32, 12)
		expect(exactSignTestP(3, 1)).toBeCloseTo((2 * 5) / 16, 12)
		expect(exactSignTestP(1, 9)).toBeCloseTo((2 * 11) / 1024, 12)
		expect(exactSignTestP(10, 0)).toBeCloseTo(2 / 1024, 12)
		expect(exactSignTestP(6, 2)).toBeCloseTo((2 * (1 + 8 + 28)) / 256, 12)
	})

	it('is 1 with no flips and never above 1', () => {
		expect(exactSignTestP(0, 0)).toBe(1)
		expect(exactSignTestP(4, 4)).toBe(1)
		expect(exactSignTestP(1, 0)).toBe(1)
	})

	it('is symmetric in the two sides', () => {
		expect(exactSignTestP(7, 2)).toBe(exactSignTestP(2, 7))
	})
})
