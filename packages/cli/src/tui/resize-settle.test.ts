import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	FULLSCREEN_RESIZE_BLANK_MS,
	FULLSCREEN_RESIZE_QUIET_MS,
	createResizeSettler,
} from './resize-settle.js'

describe('createResizeSettler', () => {
	afterEach(() => vi.useRealTimers())

	it('never blanks while resize events keep arriving', () => {
		vi.useFakeTimers()
		const calls: boolean[] = []
		const s = createResizeSettler((b) => calls.push(b))
		for (let i = 0; i < 100; i++) {
			s.resized()
			vi.advanceTimersByTime(16)
		}
		expect(calls).toEqual([])
	})

	it('draws one blank frame after the size settles, then releases it', () => {
		vi.useFakeTimers()
		const calls: boolean[] = []
		const s = createResizeSettler((b) => calls.push(b))
		s.resized()
		vi.advanceTimersByTime(FULLSCREEN_RESIZE_QUIET_MS)
		expect(calls).toEqual([true])
		vi.advanceTimersByTime(FULLSCREEN_RESIZE_BLANK_MS)
		expect(calls).toEqual([true, false])
	})

	it('releases a showing blank at once when the size changes again', () => {
		vi.useFakeTimers()
		const calls: boolean[] = []
		const s = createResizeSettler((b) => calls.push(b))
		s.resized()
		vi.advanceTimersByTime(FULLSCREEN_RESIZE_QUIET_MS)
		s.resized()
		expect(calls).toEqual([true, false])
		vi.advanceTimersByTime(FULLSCREEN_RESIZE_QUIET_MS + FULLSCREEN_RESIZE_BLANK_MS)
		expect(calls).toEqual([true, false, true, false])
	})

	it('dispose cancels a pending blank', () => {
		vi.useFakeTimers()
		const calls: boolean[] = []
		const s = createResizeSettler((b) => calls.push(b))
		s.resized()
		s.dispose()
		vi.advanceTimersByTime(1000)
		expect(calls).toEqual([])
	})
})
