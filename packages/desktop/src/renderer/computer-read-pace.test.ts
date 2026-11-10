import { describe, expect, it } from 'vitest'
import { FAILING_READ_MS, nextComputerReadDelay } from './computer-read-pace.js'

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
			seconds += nextComputerReadDelay({ ready: false, watching: false, failures }) / 1000
		}
		expect(reads).toBeLessThan(70)
	})
})
