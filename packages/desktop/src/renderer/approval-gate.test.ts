import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLICK_GUARD_MS, createClickGuard, readGateHint, unreadContent } from './approval-gate.js'

describe('the read gate', () => {
	it('holds only a box that overflows and has not been scrolled to its end', () => {
		expect(unreadContent({ scrollHeight: 500, clientHeight: 140, scrollTop: 0 })).toBe(true)
		expect(unreadContent({ scrollHeight: 500, clientHeight: 140, scrollTop: 200 })).toBe(true)
		// Within 2 px of the end counts as the end, because scroll offsets are fractional.
		expect(unreadContent({ scrollHeight: 500, clientHeight: 140, scrollTop: 358 })).toBe(false)
		expect(unreadContent({ scrollHeight: 500, clientHeight: 140, scrollTop: 360 })).toBe(false)
	})

	it('never traps a box that fits, or that overflows by no more than rounding', () => {
		expect(unreadContent({ scrollHeight: 100, clientHeight: 140, scrollTop: 0 })).toBe(false)
		expect(unreadContent({ scrollHeight: 140, clientHeight: 140, scrollTop: 0 })).toBe(false)
		expect(unreadContent({ scrollHeight: 142, clientHeight: 140, scrollTop: 0 })).toBe(false)
		expect(unreadContent({ scrollHeight: 143, clientHeight: 140, scrollTop: 0 })).toBe(true)
	})

	it('says what to scroll in words that match what is hidden', () => {
		expect(readGateHint({})).toBeUndefined()
		expect(readGateHint({ command: true, diff: true })).toBe(
			'Scroll through the whole command to allow it.',
		)
		expect(readGateHint({ message: true })).toBe('Scroll through the whole message to allow it.')
		expect(readGateHint({ diff: true })).toBe('Scroll to the end to allow this.')
	})
})

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
