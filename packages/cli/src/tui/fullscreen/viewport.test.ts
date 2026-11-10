import { describe, expect, it } from 'vitest'

import {
	FOLLOWING,
	type ViewState,
	anchorAt,
	bottomRow,
	buildRowIndex,
	hasUnseen,
	jumpHint,
	minBottom,
	moveView,
	pageRows,
	stateAt,
	syncView,
	visibleRange,
} from './viewport.js'

/** Ten messages of five rows each: rows 0-49. */
function index(sizes: readonly number[] = Array(10).fill(5)) {
	return buildRowIndex(sizes.map((rows, i) => ({ id: `m${i}`, rows })))
}

const HEIGHT = 10

describe('the row index', () => {
	it('places each message after the rows of the ones before it', () => {
		const idx = index([3, 1, 4])
		expect(idx.starts).toEqual([0, 3, 4])
		expect(idx.total).toBe(8)
	})

	it('names a row by its message and the offset inside it', () => {
		const idx = index([3, 1, 4])
		expect(anchorAt(idx, 0)).toEqual({ id: 'm0', offset: 0 })
		expect(anchorAt(idx, 2)).toEqual({ id: 'm0', offset: 2 })
		expect(anchorAt(idx, 3)).toEqual({ id: 'm1', offset: 0 })
		expect(anchorAt(idx, 7)).toEqual({ id: 'm2', offset: 3 })
	})
})

describe('following', () => {
	it('keeps the bottom edge on the last row', () => {
		expect(bottomRow(FOLLOWING, index())).toBe(49)
		expect(visibleRange(FOLLOWING, index(), HEIGHT)).toEqual({ from: 40, to: 50 })
	})

	it('draws an empty transcript as nothing', () => {
		const empty = buildRowIndex([])
		expect(bottomRow(FOLLOWING, empty)).toBe(-1)
		expect(visibleRange(FOLLOWING, empty, HEIGHT)).toEqual({ from: 0, to: 0 })
		expect(moveView(FOLLOWING, 'page-up', empty, HEIGHT)).toBe(FOLLOWING)
	})

	it('draws a transcript shorter than the window from its first row', () => {
		expect(visibleRange(FOLLOWING, index([2, 2]), HEIGHT)).toEqual({ from: 0, to: 4 })
	})
})

describe('moving', () => {
	it('pages up one row short of the window so the edge row stays in view', () => {
		expect(pageRows(HEIGHT)).toBe(9)
		const up = moveView(FOLLOWING, 'page-up', index(), HEIGHT)
		expect(bottomRow(up, index())).toBe(49 - 9)
		expect(up.follow).toBe(false)
	})

	it('moves a wheel notch at a time', () => {
		const up = moveView(FOLLOWING, 'line-up', index(), HEIGHT)
		expect(bottomRow(up, index())).toBe(46)
		const down = moveView(up, 'line-down', index(), HEIGHT)
		expect(down.follow).toBe(true)
	})

	it('resumes following when a move reaches the end', () => {
		const up = moveView(FOLLOWING, 'page-up', index(), HEIGHT)
		expect(moveView(up, 'page-down', index(), HEIGHT)).toEqual(FOLLOWING)
		expect(moveView(up, 'bottom', index(), HEIGHT)).toEqual(FOLLOWING)
	})

	it('stops at the top with the window still full', () => {
		let state: ViewState = FOLLOWING
		for (let i = 0; i < 20; i++) state = moveView(state, 'page-up', index(), HEIGHT)
		expect(bottomRow(state, index())).toBe(minBottom(index(), HEIGHT))
		expect(visibleRange(state, index(), HEIGHT).from).toBe(0)
		expect(moveView(state, 'top', index(), HEIGHT)).toBe(state)
	})

	it('returns the same object for a move that changes nothing', () => {
		expect(moveView(FOLLOWING, 'line-down', index(), HEIGHT)).toBe(FOLLOWING)
		expect(moveView(FOLLOWING, 'bottom', index(), HEIGHT)).toBe(FOLLOWING)
	})

	it('goes to the top on Home', () => {
		const state = moveView(FOLLOWING, 'top', index(), HEIGHT)
		expect(bottomRow(state, index())).toBe(HEIGHT - 1)
	})
})

describe('holding still while output arrives', () => {
	it('keeps the same rows on screen when messages are added below', () => {
		const before = index()
		const up = moveView(FOLLOWING, 'page-up', before, HEIGHT)
		const after = index([...Array(10).fill(5), 7])
		expect(bottomRow(up, after)).toBe(bottomRow(up, before))
		expect(syncView(up, after, HEIGHT)).toBe(up)
	})

	it('says new activity arrived only once the reader has left the end', () => {
		const before = index()
		const up = moveView(FOLLOWING, 'page-up', before, HEIGHT)
		expect(hasUnseen(up, before)).toBe(false)
		expect(hasUnseen(up, index([...Array(10).fill(5), 2]))).toBe(true)
		expect(hasUnseen(FOLLOWING, index([...Array(10).fill(5), 2]))).toBe(false)
	})

	it('notices the last message growing, not only a new one', () => {
		const grown = (rows: number) =>
			buildRowIndex([
				{ id: 'a', rows: 40 },
				{ id: 'b', rows, tail: `${rows * 10}` },
			])
		const up = moveView(FOLLOWING, 'page-up', grown(5), HEIGHT)
		expect(hasUnseen(up, grown(5))).toBe(false)
		expect(hasUnseen(up, grown(6))).toBe(true)
	})
})

describe('resizing', () => {
	it('keeps the message the reader was on when rows wrap differently', () => {
		const wide = index()
		const state = stateAt(wide, 22, HEIGHT)
		expect(state).toMatchObject({ anchor: { id: 'm4', offset: 2 } })
		// Narrower: every message is twice as tall.
		const narrow = index(Array(10).fill(10))
		expect(bottomRow(state, narrow)).toBe(4 * 10 + 2)
	})

	it('clamps an offset that no longer exists inside a shorter message', () => {
		const state = stateAt(index(), 24, HEIGHT) // m4, offset 4
		const shorter = index(Array(10).fill(2))
		expect(bottomRow(state, shorter)).toBe(4 * 2 + 1)
	})

	it('resumes following when the window grows past the end', () => {
		const idx = index()
		const state = stateAt(idx, 45, HEIGHT)
		expect(state.follow).toBe(false)
		// A taller window brings the end into view: the lowest allowed bottom is
		// then the last row, so the view is following again.
		expect(syncView(state, idx, 60)).toEqual(FOLLOWING)
	})

	it('falls back to the end when the anchored message is gone after a compaction', () => {
		const state = stateAt(index(), 20, HEIGHT)
		const compacted = buildRowIndex([{ id: 'summary', rows: 12 }])
		expect(bottomRow(state, compacted)).toBe(11)
		expect(syncView(state, compacted, HEIGHT)).toEqual(FOLLOWING)
	})

	it('never leaves a blank band above the first row', () => {
		const state = stateAt(index(), 2, HEIGHT)
		expect(bottomRow(state, index())).toBe(HEIGHT - 1)
	})
})

describe('the jump hint', () => {
	it('shortens before it wraps and drops to the arrow', () => {
		expect(jumpHint(80, false)).toBe('↓ Jump to latest · PgDn')
		expect(jumpHint(12, false)).toBe('↓ Latest')
		expect(jumpHint(1, false)).toBe('↓')
		expect(jumpHint(0, false)).toBeNull()
		expect(jumpHint(80, true)).toMatch(/^New activity/)
	})
})
