import { expect, it } from 'vitest'
import { changeTotals, formatLineCount } from './changes-totals.js'

it('counts added and removed lines of one edit', () => {
	expect(
		changeTotals([{ path: 'a.ts', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\nfour\n' }]),
	).toEqual({ added: 2, removed: 1, files: 1 })
})

it('counts a created file as all additions', () => {
	expect(changeTotals([{ path: 'new.txt', before: '', after: 'a\nb\nc\n' }])).toEqual({
		added: 3,
		removed: 0,
		files: 1,
	})
})

it('compares the first before with the last after, once per path', () => {
	const totals = changeTotals([
		{ path: 'a.ts', before: 'a\nb\n', after: 'a\nb\nc\n' },
		{ path: 'a.ts', before: 'a\nb\nc\n', after: 'a\nb\nc\nd\n' },
		{ path: 'b.ts', before: 'x\n', after: 'y\n' },
	])
	expect(totals).toEqual({ added: 3, removed: 1, files: 2 })
})

it('ignores a path whose last edit restores the original', () => {
	expect(
		changeTotals([
			{ path: 'a.ts', before: 'a\n', after: 'b\n' },
			{ path: 'a.ts', before: 'b\n', after: 'a\n' },
		]),
	).toEqual({ added: 0, removed: 0, files: 0 })
})

it('is empty without receipts and groups digits', () => {
	expect(changeTotals([])).toEqual({ added: 0, removed: 0, files: 0 })
	expect(formatLineCount(256340)).toBe('256,340')
})
