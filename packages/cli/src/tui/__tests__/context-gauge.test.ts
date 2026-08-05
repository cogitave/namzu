import { describe, expect, it } from 'vitest'

import { buildGauge } from '../StatusBar.js'

/**
 * What the footer's context bar may honestly claim.
 *
 * Two rules, and the second is the one with a history. The gauge must show no
 * proportion it cannot ground — it previously grounded one on a two-branch
 * guess at the window and a counter that measured something else entirely. And
 * when it does show one, the reader must be able to tell a measurement from an
 * inference, because a bar that looks measured and is not is the same defect
 * in miniature.
 */
describe('buildGauge grounds the ratio or shows nothing', () => {
	const measured = { measuredBy: 'provider', windowSource: 'model-table' } as const

	it('divides context by window, not spend by a guess', () => {
		const gauge = buildGauge({ tokens: 50_000, windowTokens: 200_000, ...measured })

		expect(gauge?.pct).toBe(25)
	})

	it('shows nothing when the window is missing', () => {
		expect(buildGauge({ tokens: 50_000, ...measured })).toBeNull()
	})

	it('shows nothing when the measurement is missing', () => {
		expect(buildGauge({ windowTokens: 200_000, ...measured })).toBeNull()
	})

	it('shows nothing at all rather than a partial gauge', () => {
		expect(buildGauge(null)).toBeNull()
		expect(buildGauge(undefined)).toBeNull()
		expect(buildGauge({})).toBeNull()
	})

	it('refuses a zero window instead of dividing by it', () => {
		// Not reachable from today's kernel, which always resolves a positive
		// window when it reports one — but Infinity rendered as a bar is a
		// worse outcome than silence, and the guard costs one comparison.
		expect(buildGauge({ tokens: 10, windowTokens: 0, ...measured })).toBeNull()
	})

	it('clamps rather than reporting over 100 percent', () => {
		const gauge = buildGauge({ tokens: 400_000, windowTokens: 200_000, ...measured })

		expect(gauge?.pct).toBe(100)
		expect(gauge?.bar).not.toContain('░')
	})
})

describe('buildGauge marks a ratio no stronger than its weaker term', () => {
	it('presents a provider count against a known window as measured', () => {
		const gauge = buildGauge({
			tokens: 50_000,
			windowTokens: 200_000,
			measuredBy: 'provider',
			windowSource: 'model-table',
		})

		expect(gauge?.approximate).toBe(false)
	})

	it('marks an estimated numerator', () => {
		const gauge = buildGauge({
			tokens: 50_000,
			windowTokens: 200_000,
			measuredBy: 'estimate',
			windowSource: 'model-table',
		})

		expect(gauge?.approximate).toBe(true)
	})

	it('marks an assumed window even when the count is exact', () => {
		// The case that makes this rule more than a rename of `measuredBy`.
		// `windowSource: 'default'` is the kernel falling back to an assumed
		// 128k because it recognised neither a configured window nor the
		// model. An exact numerator over an invented denominator is a guess
		// wearing a precise-looking figure, and marking only the numerator
		// would repeat one level down the error this whole change fixes.
		const gauge = buildGauge({
			tokens: 50_000,
			windowTokens: 128_000,
			measuredBy: 'provider',
			windowSource: 'default',
		})

		expect(gauge?.approximate).toBe(true)
	})

	it('treats an unstated provenance as not measured', () => {
		// Silence is not a claim of accuracy. Defaulting the other way would
		// let any future producer that forgets the field render as exact.
		const gauge = buildGauge({ tokens: 50_000, windowTokens: 200_000 })

		expect(gauge?.approximate).toBe(true)
	})
})
