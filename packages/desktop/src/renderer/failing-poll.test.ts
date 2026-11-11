import { describe, expect, it } from 'vitest'
import { POLL_FAILURE_LIMIT, pollDelay } from './failing-poll.js'

describe('pollDelay', () => {
	it('keeps the pace of a read that works', () => {
		expect(pollDelay(2000, 0)).toBe(2000)
	})
	it('doubles the wait for each failure in a row, then stops', () => {
		expect([1, 2, 3].map((n) => pollDelay(2000, n))).toEqual([4000, 8000, 16_000])
		expect(pollDelay(2000, POLL_FAILURE_LIMIT)).toBeNull()
		expect(pollDelay(2000, 50)).toBeNull()
	})
})
