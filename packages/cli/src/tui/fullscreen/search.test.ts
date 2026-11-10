import { describe, expect, it } from 'vitest'

import { paintRow } from './paint.js'
import type { FsRow } from './rows.js'
import {
	editSearch,
	findMatches,
	ignoresCase,
	searchLine,
	startMatch,
	stepMatch,
} from './search.js'
import { FOLLOWING, buildRowIndex, revealRow, stateAt } from './viewport.js'

function row(text: string): FsRow {
	return { glyph: ' ', glyphColor: '#fff', text, color: '#fff', joins: null, lead: 0 }
}

const rows = [row('The cat sat'), row(''), row('a Cat and a cat'), row('漢字 cat 漢字')]

describe('finding matches', () => {
	it('finds every match in reading order, ignoring case for a lower-case query', () => {
		expect(findMatches(rows, 'cat')).toEqual([
			{ row: 0, from: 4, to: 7 },
			{ row: 2, from: 2, to: 5 },
			{ row: 2, from: 12, to: 15 },
			{ row: 3, from: 5, to: 8 },
		])
	})

	it('is case sensitive once the query has a capital', () => {
		expect(ignoresCase('cat')).toBe(true)
		expect(ignoresCase('Cat')).toBe(false)
		expect(findMatches(rows, 'Cat')).toEqual([{ row: 2, from: 2, to: 5 }])
	})

	it('reports cells, so a match after wide characters is where it is drawn', () => {
		expect(findMatches([row('漢字 cat')], 'cat')).toEqual([{ row: 0, from: 5, to: 8 }])
		expect(findMatches([row('漢字 cat')], '字')).toEqual([{ row: 0, from: 2, to: 4 }])
	})

	it('finds nothing for an empty query or a missing word', () => {
		expect(findMatches(rows, '')).toEqual([])
		expect(findMatches(rows, 'dog')).toEqual([])
	})

	it('finds overlapping and repeated matches once each', () => {
		expect(findMatches([row('aaaa')], 'aa')).toHaveLength(2)
	})
})

describe('moving between matches', () => {
	const found = findMatches(rows, 'cat')

	it('starts at the nearest match at or above the bottom of the window', () => {
		expect(startMatch(found, 2)).toBe(2)
		expect(startMatch(found, 3)).toBe(3)
		expect(startMatch(found, 0)).toBe(0)
		expect(startMatch([], 5)).toBe(-1)
	})

	it('steps forward and back, round the ends', () => {
		expect(stepMatch(4, 0, 1)).toBe(1)
		expect(stepMatch(4, 3, 1)).toBe(0)
		expect(stepMatch(4, 0, -1)).toBe(3)
		expect(stepMatch(4, -1, 1)).toBe(0)
		expect(stepMatch(4, -1, -1)).toBe(3)
		expect(stepMatch(0, -1, 1)).toBe(-1)
	})

	it('scrolls the view to a match out of sight and leaves one in sight alone', () => {
		const index = buildRowIndex(Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, rows: 1 })))
		expect(revealRow(FOLLOWING, index, 95, 10)).toBe(FOLLOWING)
		const moved = revealRow(FOLLOWING, index, 10, 10)
		expect(moved.follow).toBe(false)
		// The window now has row 10 in it.
		const again = revealRow(moved, index, 10, 10)
		expect(again).toBe(moved)
		const lower = stateAt(index, 50, 10)
		expect(revealRow(lower, index, 45, 10)).toBe(lower)
	})
})

describe('the search line', () => {
	it('types, erases and moves with the keys the composer is used to', () => {
		expect(editSearch('ca', 't', {})).toEqual({ kind: 'query', query: 'cat' })
		expect(editSearch('cat', '', { backspace: true })).toEqual({ kind: 'query', query: 'ca' })
		expect(editSearch('漢字', '', { backspace: true })).toEqual({ kind: 'query', query: '漢' })
		expect(editSearch('cat', '', { return: true })).toEqual({ kind: 'next' })
		expect(editSearch('cat', '', { return: true, shift: true })).toEqual({ kind: 'previous' })
		expect(editSearch('cat', '', { return: true, meta: true })).toEqual({ kind: 'previous' })
		expect(editSearch('cat', '', { downArrow: true })).toEqual({ kind: 'next' })
		expect(editSearch('cat', '', { upArrow: true })).toEqual({ kind: 'previous' })
		expect(editSearch('cat', '', { escape: true })).toEqual({ kind: 'close' })
		expect(editSearch('cat', 'x', { ctrl: true })).toEqual({ kind: 'none' })
		expect(editSearch('cat', '\u001b', {})).toEqual({ kind: 'none' })
	})

	it('names the match it is on, and says when there is none', () => {
		expect(searchLine('cat', 1, 4, 80)).toBe('Find: cat▏  2/4  ↵ next · ⇧↵ previous · esc close')
		expect(searchLine('dog', -1, 0, 80)).toContain('No matches')
		expect(searchLine('', -1, 0, 80)).toBe('Find: ▏  ↵ next · ⇧↵ previous · esc close')
	})

	it('shortens to what fits, and keeps the end of a long query', () => {
		for (const width of [60, 30, 18, 10]) {
			expect(searchLine('cat', 0, 4, width).length).toBeLessThanOrEqual(width)
		}
		const long = searchLine('a very long query indeed', 0, 3, 20)
		expect(long.length).toBeLessThanOrEqual(20)
		expect(long).toContain('indeed')
	})
})

describe('highlights', () => {
	it('lays marks over a row without touching the text', () => {
		const spans = paintRow(row('a cat sat'), [{ from: 2, to: 5, style: { inverse: true } }])
		expect(spans.map((s) => s.text).join('')).toBe('a cat sat')
		expect(spans.map((s) => [s.text, s.inverse === true])).toEqual([
			['a ', false],
			['cat', true],
			[' sat', false],
		])
	})

	it('marks a wide character whole and lets a later mark win', () => {
		const spans = paintRow(row('a漢b'), [
			{ from: 0, to: 3, style: { underline: true } },
			{ from: 1, to: 3, style: { inverse: true } },
		])
		expect(spans.map((s) => [s.text, s.underline === true, s.inverse === true])).toEqual([
			['a', true, false],
			['漢', false, true],
			['b', false, false],
		])
	})

	it('returns a row with no marks as it is', () => {
		const plain = row('plain')
		expect(paintRow(plain, [])).toEqual([{ text: 'plain', color: '#fff' }])
	})
})
