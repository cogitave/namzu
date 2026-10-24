import { describe, expect, it } from 'vitest'

import { PauseClock } from '../pause-clock.js'

describe('PauseClock', () => {
	it('adds up closed waits and counts an open one', () => {
		const clock = new PauseClock()
		clock.begin(1_000)
		clock.end(4_000)
		clock.begin(10_000)
		expect(clock.total(11_500)).toBe(4_500)
		clock.end(12_000)
		expect(clock.total(99_000)).toBe(5_000)
	})

	it('ignores a repeated begin and an end with nothing open', () => {
		const clock = new PauseClock()
		clock.end(500)
		clock.begin(1_000)
		clock.begin(3_000)
		clock.end(5_000)
		expect(clock.total(9_000)).toBe(4_000)
	})
})
