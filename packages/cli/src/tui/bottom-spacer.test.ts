import { describe, expect, it } from 'vitest'

import { SAFETY_ROWS, bottomSpacerRows, estimateRenderedLines } from './bottom-spacer.js'

const LIVE = 8

function rowsFor(transcript: readonly string[], rows = 40, columns = 80): number {
	return bottomSpacerRows({ rows, columns, transcript, liveRows: LIVE })
}

describe('bottomSpacerRows', () => {
	it('pads an empty transcript, which is the case people see on launch', () => {
		expect(rowsFor([])).toBe(40 - LIVE - SAFETY_ROWS)
	})

	it('pads a short transcript', () => {
		expect(rowsFor(['hello', 'world'])).toBeGreaterThan(0)
	})

	it('shrinks as the transcript grows', () => {
		const a = rowsFor(['one'])
		const b = rowsFor(['one', 'two'])
		const c = rowsFor(['one', 'two', 'three'])
		expect(a).toBeGreaterThan(b)
		expect(b).toBeGreaterThan(c)
	})

	it('stops entirely once the transcript approaches the viewport', () => {
		// The terminal is scrolling by now and the composer is already at the
		// bottom. Padding here is what would push it out of view.
		const long = Array.from({ length: 40 }, (_, i) => `line ${i}`)
		expect(rowsFor(long)).toBe(0)
	})

	it('never itself pushes the layout past the viewport', () => {
		// The property that keeps a wrong estimate merely cosmetic, stated
		// precisely: WHEN it pads, the total must fit. When it declines to pad,
		// the content may well exceed the viewport — that is the scrolling case,
		// and it is the terminal's business rather than this function's.
		//
		// The first version of this test asserted the total unconditionally and
		// failed at n=33, where the transcript alone is already taller than the
		// screen. That was the test overclaiming, not the code misbehaving.
		for (let n = 0; n < 60; n++) {
			const transcript = Array.from({ length: n }, (_, i) => `line ${i}`)
			const spacer = rowsFor(transcript)
			if (spacer === 0) continue
			const used = estimateRenderedLines(transcript, 80) + LIVE + spacer
			expect(used, `n=${n}`).toBeLessThanOrEqual(40)
		}
	})

	it('pads only while the content genuinely fits', () => {
		// The complement of the above: there must BE a point where it stops, or
		// the guard is decoration.
		const padded = []
		for (let n = 0; n < 60; n++) {
			const transcript = Array.from({ length: n }, (_, i) => `line ${i}`)
			if (rowsFor(transcript) > 0) padded.push(n)
		}
		expect(padded.length).toBeGreaterThan(0)
		expect(Math.max(...padded)).toBeLessThan(40 - LIVE)
	})

	it('counts a wrapped line as more than one row', () => {
		// Underestimating width is how a spacer pushes the composer off-screen.
		const wide = 'x'.repeat(400)
		expect(estimateRenderedLines([wide], 80)).toBe(5)
		expect(rowsFor([wide])).toBeLessThan(rowsFor(['x']))
	})

	it('counts embedded newlines', () => {
		expect(estimateRenderedLines(['a\nb\nc'], 80)).toBe(3)
	})

	it('counts an empty entry as a row, because it renders as one', () => {
		expect(estimateRenderedLines(['', ''], 80)).toBe(2)
	})
})

describe('refusing to guess', () => {
	it('does nothing when there is no terminal height', () => {
		// A pipe has no bottom to pin to.
		expect(bottomSpacerRows({ rows: undefined, columns: 80, transcript: [], liveRows: LIVE })).toBe(
			0,
		)
	})

	it('does nothing on a terminal too short to reason about', () => {
		expect(bottomSpacerRows({ rows: 8, columns: 80, transcript: [], liveRows: LIVE })).toBe(0)
	})

	it('does nothing when the height is not a number', () => {
		expect(
			bottomSpacerRows({ rows: Number.NaN, columns: 80, transcript: [], liveRows: LIVE }),
		).toBe(0)
	})

	it('assumes a narrow terminal rather than a wide one when width is unknown', () => {
		// Unknown width must resolve toward MORE wrapping — more content, less
		// padding — because the opposite error is the one that hurts.
		const wide = 'x'.repeat(400)
		const unknown = estimateRenderedLines([wide], undefined)
		expect(unknown).toBeGreaterThanOrEqual(estimateRenderedLines([wide], 200))
	})

	it('keeps a floor under the assumed width', () => {
		// A 1-column terminal would otherwise make every line astronomically
		// tall and the arithmetic meaningless.
		expect(estimateRenderedLines(['hello'], 1)).toBe(1)
	})
})
