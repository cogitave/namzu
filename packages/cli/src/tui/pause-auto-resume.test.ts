import { describe, expect, it, vi } from 'vitest'

import {
	AUTO_RESUME_DELAYS_MS,
	autoResumeDelayMs,
	isAutoResumable,
	startAutoResume,
} from './pause-auto-resume.js'

describe('the schedule a paused reply tries again on', () => {
	it('waits longer each time and then holds at the last step', () => {
		expect([1, 2, 3, 4, 5, 6, 40].map(autoResumeDelayMs)).toEqual([
			15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000,
		])
		expect(AUTO_RESUME_DELAYS_MS.at(-1)).toBe(300_000)
	})

	it('never goes below the first step', () => {
		expect(autoResumeDelayMs(0)).toBe(15_000)
		expect(autoResumeDelayMs(-3)).toBe(15_000)
	})

	it('mends only what can pass by itself', () => {
		expect(isAutoResumable('network')).toBe(true)
		expect(isAutoResumable('server')).toBe(true)
		for (const kind of [
			'auth',
			'permission',
			'rate_limit',
			'model_not_found',
			'context',
			'bad_request',
			'unknown',
		] as const) {
			expect(isAutoResumable(kind)).toBe(false)
		}
	})
})

describe('trying again on its own', () => {
	it('continues the reply when the wait is over, and not before', () => {
		vi.useFakeTimers()
		try {
			const resume = vi.fn()
			startAutoResume({ delayMs: 15_000, ready: () => true, resume })
			vi.advanceTimersByTime(14_999)
			expect(resume).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1)
			expect(resume).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(10 * 60_000)
			expect(resume).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it('waits further while the screen is busy, then continues once', () => {
		vi.useFakeTimers()
		try {
			let busy = true
			const resume = vi.fn()
			startAutoResume({ delayMs: 1_000, recheckMs: 500, ready: () => !busy, resume })
			vi.advanceTimersByTime(1_000)
			vi.advanceTimersByTime(2_000)
			expect(resume).not.toHaveBeenCalled()
			busy = false
			vi.advanceTimersByTime(500)
			expect(resume).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does nothing once the person has moved on', () => {
		vi.useFakeTimers()
		try {
			const resume = vi.fn()
			const cancel = startAutoResume({ delayMs: 15_000, ready: () => true, resume })
			cancel()
			vi.advanceTimersByTime(60_000)
			expect(resume).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it('does nothing when cancelled while it was waiting for a busy screen', () => {
		vi.useFakeTimers()
		try {
			const resume = vi.fn()
			const cancel = startAutoResume({
				delayMs: 100,
				recheckMs: 100,
				ready: () => false,
				resume,
			})
			vi.advanceTimersByTime(350)
			cancel()
			vi.advanceTimersByTime(10_000)
			expect(resume).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})
