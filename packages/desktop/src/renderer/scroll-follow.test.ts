import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAutoScrollMark,
	createReaderInput,
	followAfterDisclosure,
	latestThreshold,
	panelPausesFollow,
	readScroll,
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

describe('whose scroll it is', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000)
	})
	afterEach(() => vi.useRealTimers())

	it('is the reader only for a moment after a wheel, touch or key', () => {
		const input = createReaderInput()
		expect(input.recent()).toBe(false)
		input.touch()
		expect(input.recent()).toBe(true)
		vi.advanceTimersByTime(299)
		expect(input.recent()).toBe(true)
		vi.advanceTimersByTime(2)
		expect(input.recent()).toBe(false)
	})
	it('stays the reader while a pointer is held on the scrollbar, and for a moment after', () => {
		const input = createReaderInput()
		input.hold()
		vi.advanceTimersByTime(5_000)
		expect(input.recent()).toBe(true)
		input.release()
		vi.advanceTimersByTime(301)
		expect(input.recent()).toBe(false)
	})
	it('stays the reader through a fling after the finger lifts, then stops', () => {
		const input = createReaderInput()
		input.touch(1_500)
		vi.advanceTimersByTime(1_700)
		expect(input.recent()).toBe(true)
		vi.advanceTimersByTime(200)
		expect(input.recent()).toBe(false)
	})
	it('keeps following and pins again when the browser moved the view', () => {
		expect(
			readScroll({ following: true, atLatest: false, movedUp: true, fromReader: false }),
		).toEqual({ follow: true, repin: true })
	})
	it('does not pin a view the reader already left', () => {
		expect(
			readScroll({ following: false, atLatest: false, movedUp: true, fromReader: false }),
		).toEqual({ follow: false, repin: false })
	})
	it('stops following when the reader scrolls up', () => {
		expect(
			readScroll({ following: true, atLatest: false, movedUp: true, fromReader: true }),
		).toEqual({ follow: false, repin: false })
	})
	it('leaves following alone when the reader scrolls down but not to the end', () => {
		expect(
			readScroll({ following: true, atLatest: false, movedUp: false, fromReader: true }),
		).toEqual({ follow: true, repin: false })
	})
	it('follows when the scroll lands at the end', () => {
		expect(
			readScroll({ following: false, atLatest: true, movedUp: false, fromReader: true }),
		).toEqual({ follow: true, repin: false })
	})
})
