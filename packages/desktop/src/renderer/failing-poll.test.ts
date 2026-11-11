import { describe, expect, it, vi } from 'vitest'
import { POLL_FAILURE_LIMIT, createFailingPoll, pollDelay } from './failing-poll.js'

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

describe('createFailingPoll', () => {
	it('reads on the base pace, slows after each failure, and gives up after the limit', async () => {
		vi.useFakeTimers()
		try {
			const read = vi.fn(async () => false)
			const poll = createFailingPoll({ baseMs: 2000, read })
			poll.start()
			await vi.advanceTimersByTimeAsync(0)
			expect(read).toHaveBeenCalledTimes(1)
			// 4 s, 8 s and 16 s after the failures: three more reads, then none.
			await vi.advanceTimersByTimeAsync(4000 + 8000 + 16_000)
			expect(read).toHaveBeenCalledTimes(POLL_FAILURE_LIMIT)
			expect(poll.stopped).toBe(true)
			await vi.advanceTimersByTimeAsync(10 * 60_000)
			expect(read).toHaveBeenCalledTimes(POLL_FAILURE_LIMIT)
		} finally {
			vi.useRealTimers()
		}
	})

	it('starts again on resume, reading at once and keeping its pace when the read works', async () => {
		vi.useFakeTimers()
		try {
			let works = false
			const read = vi.fn(async () => works)
			const poll = createFailingPoll({ baseMs: 2000, read })
			poll.start()
			await vi.advanceTimersByTimeAsync(28_000)
			expect(poll.stopped).toBe(true)
			const before = read.mock.calls.length
			works = true
			poll.resume()
			await vi.advanceTimersByTimeAsync(0)
			expect(read).toHaveBeenCalledTimes(before + 1)
			expect(poll.stopped).toBe(false)
			await vi.advanceTimersByTimeAsync(6000)
			expect(read).toHaveBeenCalledTimes(before + 4)
			poll.stop()
			await vi.advanceTimersByTimeAsync(60_000)
			expect(read).toHaveBeenCalledTimes(before + 4)
		} finally {
			vi.useRealTimers()
		}
	})
})
