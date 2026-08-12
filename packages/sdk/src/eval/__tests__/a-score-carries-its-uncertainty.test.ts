import { describe, expect, it } from 'vitest'

import { describeUncertainty, uncertaintyOf } from '../uncertainty.js'

/**
 * A suite reported a mean and nothing else, so two runs three points apart
 * read as a difference. At the n a hand-built suite has, that is usually
 * the same run twice.
 *
 * The risk in fixing it is producing a number that looks precise and is
 * not — a too-narrow interval is worse than no interval, because it turns
 * "we cannot tell" into an answer. These tests are mostly about that.
 */

describe('an interval over few cases', () => {
	it('uses the t value, not 1.96, where the difference matters', () => {
		// Five identical-spread scores. With the normal approximation the
		// margin would be 1.96 SE; the true two-sided 95% multiplier at df=4
		// is 2.776, so a normal interval is ~29% too narrow exactly where a
		// suite is small enough to mislead.
		const u = uncertaintyOf([0.2, 0.4, 0.6, 0.8, 1.0])

		expect(u.n).toBe(5)
		expect(u.margin95 / u.stdError).toBeCloseTo(2.776, 2)
	})

	it('refuses to state an interval from one case', () => {
		// One case has no spread. Reporting ±0 would be the most
		// confident-looking output the suite can produce from the least
		// evidence it can have.
		const u = uncertaintyOf([0.9])

		expect(u.undefinedInterval).toBe(true)
		expect(u.margin95).toBeNaN()
	})

	it('says there is no score at all when nothing was scored', () => {
		const u = uncertaintyOf([])

		expect(u.n).toBe(0)
		expect(u.undefinedInterval).toBe(true)
		expect(describeUncertainty(0, u)).toContain('no scored cases')
	})
})

describe('the numbers themselves', () => {
	it('reports zero spread for identical scores, and an interval of zero width', () => {
		const u = uncertaintyOf([0.75, 0.75, 0.75, 0.75])

		expect(u.stdDev).toBe(0)
		expect(u.stdError).toBe(0)
		expect(u.margin95).toBe(0)
	})

	it('divides by n-1, because the question is about the suite not these cases', () => {
		// Bessel. For [0, 1] the population SD is 0.5 and the sample SD is
		// √½; using the first would understate every interval.
		//
		// Written as `Math.SQRT1_2` rather than 0.7071 because that is what
		// the number IS — a literal here reads as a tolerance somebody chose
		// and invites the next reader to loosen it.
		const u = uncertaintyOf([0, 1])

		expect(u.stdDev).toBeCloseTo(Math.SQRT1_2, 10)
		expect(u.stdDev).toBeGreaterThan(0.5)
	})

	it('narrows as cases are added, which is the point of adding them', () => {
		const few = uncertaintyOf([0.4, 0.6, 0.4, 0.6])
		const many = uncertaintyOf([0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6])

		expect(many.margin95).toBeLessThan(few.margin95)
	})
})

describe('what a reader is shown', () => {
	it('clamps the printed interval to the scale without hiding the width', () => {
		// A mean near 1 with a wide interval otherwise reports an upper bound
		// above 1, which is not a possible score and makes a reader distrust
		// the figure. The clamp is cosmetic; `margin95` still carries the
		// real width.
		const u = uncertaintyOf([0.9, 1.0, 0.95, 1.0, 0.85])

		expect(u.ci95[1]).toBeLessThanOrEqual(1)
		expect(u.ci95[0]).toBeGreaterThanOrEqual(0)
		expect(u.margin95).toBeGreaterThan(0)
	})

	it('states the independence assumption, because it may not hold', () => {
		// Clustered standard errors run up to 3x the naive figure when cases
		// come from related groups. There is no grouping key here to cluster
		// on, so the honest move is to name the assumption rather than let a
		// reader take the interval as final.
		const u = uncertaintyOf([0.5, 0.7, 0.6])

		expect(describeUncertainty(0.6, u)).toContain('independent')
	})

	it('names n, so an interval cannot be read without knowing what it rests on', () => {
		const u = uncertaintyOf([0.5, 0.7, 0.6])

		expect(describeUncertainty(0.6, u)).toContain('n=3')
	})
})
