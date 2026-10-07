import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThrottle } from './throttled-text.js'

describe('createThrottle', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000_000)
	})
	afterEach(() => vi.useRealTimers())

	it('delivers the first value at once', () => {
		const seen: string[] = []
		const throttle = createThrottle((value: string) => seen.push(value), 50)
		throttle.push('a')
		expect(seen).toEqual(['a'])
	})

	it('holds a burst back and delivers only its last value when the interval ends', () => {
		const seen: string[] = []
		const throttle = createThrottle((value: string) => seen.push(value), 50)
		throttle.push('a')
		for (const value of ['b', 'c', 'd']) {
			vi.advanceTimersByTime(10)
			throttle.push(value)
		}
		expect(seen).toEqual(['a'])
		vi.advanceTimersByTime(19)
		expect(seen).toEqual(['a'])
		vi.advanceTimersByTime(1)
		expect(seen).toEqual(['a', 'd'])
	})

	it('turns a stream of one delta per 16 ms into one change per 50 ms', () => {
		const seen: number[] = []
		const throttle = createThrottle((value: number) => seen.push(value), 50)
		for (let delta = 0; delta < 100; delta++) {
			throttle.push(delta)
			vi.advanceTimersByTime(16)
		}
		vi.advanceTimersByTime(50)
		expect(seen.length).toBeLessThanOrEqual(Math.ceil((100 * 16) / 50) + 2)
		expect(seen.at(-1)).toBe(99)
	})

	it('delivers at once again after a quiet interval', () => {
		const seen: string[] = []
		const throttle = createThrottle((value: string) => seen.push(value), 50)
		throttle.push('a')
		vi.advanceTimersByTime(50)
		throttle.push('b')
		expect(seen).toEqual(['a', 'b'])
	})

	it('flush delivers now and drops the waiting value', () => {
		const seen: string[] = []
		const throttle = createThrottle((value: string) => seen.push(value), 50)
		throttle.push('a')
		throttle.push('b')
		throttle.flush('final')
		vi.advanceTimersByTime(200)
		expect(seen).toEqual(['a', 'final'])
	})

	it('cancel drops the waiting value', () => {
		const seen: string[] = []
		const throttle = createThrottle((value: string) => seen.push(value), 50)
		throttle.push('a')
		throttle.push('b')
		throttle.cancel()
		vi.advanceTimersByTime(200)
		expect(seen).toEqual(['a'])
		expect(vi.getTimerCount()).toBe(0)
	})
})
