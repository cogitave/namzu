import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAutoScrollMark,
	followAfterDisclosure,
	latestThreshold,
	panelPausesFollow,
} from './scroll-follow.js'

describe('createAutoScrollMark', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
	})
	afterEach(() => vi.useRealTimers())

	it('recognises the echo of a programmatic scroll once', () => {
		const mark = createAutoScrollMark()
		mark.mark(500)
		expect(mark.consume(500)).toBe(true)
		expect(mark.consume(500)).toBe(false)
	})

	it('allows a pixel of rounding and no more', () => {
		const mark = createAutoScrollMark()
		mark.mark(500)
		expect(mark.consume(499.5)).toBe(true)
		mark.mark(500)
		expect(mark.consume(480)).toBe(false)
	})

	it('treats a scroll to another place as the reader, and keeps the mark for the echo that follows', () => {
		const mark = createAutoScrollMark()
		mark.mark(500)
		expect(mark.consume(120)).toBe(false)
		expect(mark.consume(500)).toBe(true)
	})

	it('lets a mark expire, so an unanswered one cannot hide a later reader scroll', () => {
		const mark = createAutoScrollMark(250)
		mark.mark(500)
		vi.advanceTimersByTime(251)
		expect(mark.consume(500)).toBe(false)
	})

	it('uses the newest mark when the code scrolls twice before the event', () => {
		const mark = createAutoScrollMark()
		mark.mark(500)
		mark.mark(560)
		expect(mark.consume(560)).toBe(true)
	})
})

describe('followAfterDisclosure', () => {
	it('keeps following only when the opened panel left the reader at the end', () => {
		expect(followAfterDisclosure(0)).toBe(true)
		expect(followAfterDisclosure(latestThreshold)).toBe(true)
		expect(followAfterDisclosure(latestThreshold + 1)).toBe(false)
		expect(followAfterDisclosure(900)).toBe(false)
	})

	it('keeps following past a small panel when a fast stream moved the end, but not past a tall one or a reader who scrolled', () => {
		const base = { wasFollowing: true, panelHeight: 120, viewportHeight: 900 }
		expect(followAfterDisclosure(300, base)).toBe(true)
		expect(followAfterDisclosure(300, { ...base, panelHeight: 600 })).toBe(false)
		expect(followAfterDisclosure(300, { ...base, moved: true })).toBe(false)
		expect(followAfterDisclosure(300, { ...base, wasFollowing: false })).toBe(false)
		expect(followAfterDisclosure(300, { ...base, panelHeight: undefined })).toBe(false)
	})
})

describe('panelPausesFollow', () => {
	it('lets a small panel grow under a following reader and pauses for a tall one', () => {
		expect(panelPausesFollow(34, 900)).toBe(false)
		expect(panelPausesFollow(300, 900)).toBe(false)
		expect(panelPausesFollow(301, 900)).toBe(true)
		expect(panelPausesFollow(undefined, 900)).toBe(false)
	})
})
