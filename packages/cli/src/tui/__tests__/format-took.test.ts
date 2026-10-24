import { describe, expect, it } from 'vitest'

import { formatElapsed, formatTook } from '../units.js'

describe('formatTook', () => {
	it('says a sub-second duration in milliseconds, as the reference does', () => {
		expect(formatTook(420)).toBe('420ms')
		expect(formatTook(999.4)).toBe('999ms')
	})
	it('matches the live counter from one second on, and at zero', () => {
		for (const ms of [0, 1_000, 3_200, 83_000, 7_384_000]) {
			expect(formatTook(ms)).toBe(formatElapsed(ms))
		}
		expect(formatElapsed(420)).toBe('0s')
	})
})
