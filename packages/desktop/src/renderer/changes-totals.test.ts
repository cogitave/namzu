import { expect, it } from 'vitest'
import { changeTotals, formatLineCount } from './changes-totals.js'

it('counts added and removed lines of one edit', () => {
	expect(
		changeTotals([{ path: 'a.ts', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\nfour\n' }]),
	).toEqual({ added: 2, removed: 1, files: 1, cut: false })
})

it('counts a created file as all additions', () => {
	expect(changeTotals([{ path: 'new.txt', before: '', after: 'a\nb\nc\n' }])).toEqual({
		added: 3,
		removed: 0,
		files: 1,
		cut: false,
	})
})

it('sums the edits of a path and counts the path once', () => {
	const totals = changeTotals([
		{ path: 'a.ts', before: 'a\nb\n', after: 'a\nb\nc\n' },
		{ path: 'a.ts', before: 'a\nb\nc\n', after: 'a\nb\nc\nd\n' },
		{ path: 'b.ts', before: 'x\n', after: 'y\n' },
	])
	expect(totals).toEqual({ added: 3, removed: 1, files: 2, cut: false })
})

it('reads two edits to different lines as the sum, never the first removed against the last added', () => {
	// What the engine's receipt carries per edit: the hunk sides of that edit alone.
	const totals = changeTotals([
		{ path: 'cart.js', before: 'a1\n', after: 'a2\n' },
		{ path: 'cart.js', before: 'z1\n', after: 'z2\n' },
	])
	expect(totals).toEqual({ added: 2, removed: 2, files: 1, cut: false })
})

it('prefers the counts the engine reported for an edit over comparing its sides', () => {
	expect(
		changeTotals([
			{ path: 'a.ts', before: 'x\n', after: 'y\n', added: 5, removed: 4 },
			{ path: 'a.ts', before: 'x\n', after: 'y\n', added: 1, removed: 0 },
		]),
	).toEqual({ added: 6, removed: 4, files: 1, cut: false })
})

it('keeps the true count of a cut diff and says it was cut', () => {
	const totals = changeTotals([
		{ path: 'big.ts', before: '', after: 'a\n', added: 477, removed: 0, cut: true },
	])
	expect(totals).toEqual({ added: 477, removed: 0, files: 1, cut: true })
})

it('is empty without receipts and groups digits', () => {
	expect(changeTotals([])).toEqual({ added: 0, removed: 0, files: 0, cut: false })
	expect(formatLineCount(256340)).toBe('256,340')
})
