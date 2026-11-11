import { describe, expect, it, vi } from 'vitest'
import {
	FAILING_READ_MS,
	createComputerReadScheduler,
	nextComputerReadDelay,
} from './computer-read-pace.js'

describe('nextComputerReadDelay', () => {
	it('keeps the pace the page had: 1 s while watching a ready computer, otherwise 5 s', () => {
		expect(nextComputerReadDelay({ ready: true, watching: true, failures: 0 })).toBe(1_000)
		expect(nextComputerReadDelay({ ready: true, watching: false, failures: 0 })).toBe(5_000)
		expect(nextComputerReadDelay({ ready: false, watching: true, failures: 0 })).toBe(5_000)
	})

	it('doubles the wait for each failed read in a row, up to a minute', () => {
		const waits = [1, 2, 3, 4, 5, 6, 40].map((failures) =>
			nextComputerReadDelay({ ready: false, watching: true, failures }),
		)
		expect(waits).toEqual([
			10_000,
			20_000,
			40_000,
			FAILING_READ_MS,
			FAILING_READ_MS,
			FAILING_READ_MS,
			FAILING_READ_MS,
		])
	})

	it('never backs off a read that worked, whatever came before it', () => {
		expect(nextComputerReadDelay({ ready: true, watching: true, failures: 0 })).toBe(1_000)
	})

	it('sends 692 failed reads in an hour down to about 63', () => {
		let seconds = 0
		let reads = 0
		for (let failures = 0; seconds < 3_600; failures += 1) {
			reads += 1
			seconds += (nextComputerReadDelay({ ready: false, watching: false, failures }) ?? 0) / 1000
		}
		expect(reads).toBeLessThan(70)
	})
})

describe('a computer that is not set up', () => {
	it('has no next read at all', () => {
		expect(nextComputerReadDelay({ ready: false, watching: true, failures: 0, parked: true })).toBe(
			null,
		)
	})

	it('is read once, then never again however long the window stays open', async () => {
		vi.useFakeTimers()
		try {
			const reads = vi.fn()
			const scheduler = createComputerReadScheduler({
				run: () => {
					reads()
					scheduler.settle({
						ready: false,
						watching: true,
						failed: false,
						answered: true,
						parked: true,
					})
				},
			})
			scheduler.settle({
				ready: false,
				watching: true,
				failed: false,
				answered: false,
				parked: false,
			})
			await vi.advanceTimersByTimeAsync(10 * 60_000)
			expect(reads).toHaveBeenCalledTimes(1)
			expect(scheduler.parked).toBe(true)
			await vi.advanceTimersByTimeAsync(60 * 60_000)
			expect(reads).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it('keeps reading a computer that is only stopped, at the ordinary pace', async () => {
		vi.useFakeTimers()
		try {
			const reads = vi.fn()
			const scheduler = createComputerReadScheduler({
				run: () => {
					reads()
					scheduler.settle({
						ready: false,
						watching: false,
						failed: false,
						answered: true,
						parked: false,
					})
				},
			})
			scheduler.settle({
				ready: false,
				watching: false,
				failed: false,
				answered: true,
				parked: false,
			})
			await vi.advanceTimersByTimeAsync(60_000)
			expect(reads).toHaveBeenCalledTimes(12)
			expect(scheduler.parked).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('a stopped scheduler schedules nothing more', async () => {
		vi.useFakeTimers()
		try {
			const run = vi.fn()
			const scheduler = createComputerReadScheduler({ run })
			scheduler.stop()
			scheduler.settle({
				ready: true,
				watching: true,
				failed: false,
				answered: true,
				parked: false,
			})
			await vi.advanceTimersByTimeAsync(60_000)
			expect(run).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it('is no longer parked once it is stopped, so a left Pal holds no wake-up', () => {
		const scheduler = createComputerReadScheduler({ run: () => {} })
		scheduler.settle({
			ready: false,
			watching: false,
			failed: false,
			answered: true,
			parked: true,
		})
		expect(scheduler.parked).toBe(true)
		scheduler.stop()
		expect(scheduler.parked).toBe(false)
	})
})
