import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLICK_GUARD_MS, createClickGuard } from './approval-gate.js'

describe('the click guard', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('swallows a click for 400 ms after the card appears, then lets one through and says so once', () => {
		const settled = vi.fn()
		const guard = createClickGuard(settled)
		expect(CLICK_GUARD_MS).toBe(400)
		expect(guard.active()).toBe(true)
		vi.advanceTimersByTime(399)
		expect(guard.active()).toBe(true)
		expect(settled).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(guard.active()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(5_000)
		expect(settled).toHaveBeenCalledTimes(1)
		guard.dispose()
	})

	it('starts over when the request changes, so a card that replaces another is guarded too', () => {
		const settled = vi.fn()
		const guard = createClickGuard(settled)
		vi.advanceTimersByTime(CLICK_GUARD_MS)
		expect(guard.active()).toBe(false)
		guard.reset()
		expect(guard.active()).toBe(true)
		vi.advanceTimersByTime(399)
		expect(guard.active()).toBe(true)
		vi.advanceTimersByTime(1)
		expect(guard.active()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(2)
		guard.dispose()
	})

	it('a reset in the middle of the guard pushes the end out rather than ending twice', () => {
		const settled = vi.fn()
		const guard = createClickGuard(settled)
		vi.advanceTimersByTime(300)
		guard.reset()
		vi.advanceTimersByTime(300)
		expect(guard.active()).toBe(true)
		expect(settled).not.toHaveBeenCalled()
		vi.advanceTimersByTime(100)
		expect(guard.active()).toBe(false)
		expect(settled).toHaveBeenCalledTimes(1)
		guard.dispose()
	})

	it('reports nothing once disposed', () => {
		const settled = vi.fn()
		const guard = createClickGuard(settled)
		guard.dispose()
		vi.advanceTimersByTime(1_000)
		expect(settled).not.toHaveBeenCalled()
	})

	it('does not report an end the clock has not reached', () => {
		let now = 1_000
		const settled = vi.fn()
		// A timer that fires on time while the injected clock reads early must wait for the clock.
		const guard = createClickGuard(settled, { now: () => now })
		vi.advanceTimersByTime(CLICK_GUARD_MS)
		expect(settled).not.toHaveBeenCalled()
		now += CLICK_GUARD_MS
		vi.advanceTimersByTime(CLICK_GUARD_MS)
		expect(settled).toHaveBeenCalledTimes(1)
		guard.dispose()
	})
})
