import { describe, expect, it } from 'vitest'

import {
	chipRanges,
	expandChips,
	highestAttachmentNumber,
	isChipPaste,
	keepChipsWhole,
	numberAttachments,
	pasteChip,
	pasteChipLines,
	snapOutOfChip,
	widenOverChips,
} from './paste-chips.js'

describe('paste chips', () => {
	it('names the extra lines, or none when there are none', () => {
		expect(pasteChip(1, `${'a'.repeat(900)}`)).toBe('[Pasted text #1]')
		expect(pasteChip(2, 'a\nb\nc\nd')).toBe('[Pasted text #2 +3 lines]')
	})

	it('holds a paste as a chip past 800 characters or min(rows - 10, 2) newlines', () => {
		expect(pasteChipLines(40)).toBe(2)
		expect(pasteChipLines(11)).toBe(1)
		expect(isChipPaste('a\nb\nc', 40)).toBe(false)
		expect(isChipPaste('a\nb\nc\nd', 40)).toBe(true)
		expect(isChipPaste('a\nb\nc', 11)).toBe(true)
		expect(isChipPaste('x'.repeat(800), 40)).toBe(false)
		expect(isChipPaste('x'.repeat(801), 40)).toBe(true)
	})

	it('puts the pasted text back, and leaves a chip it does not know', () => {
		const store = new Map([[1, 'one\ntwo\nthree\nfour']])
		expect(expandChips('see [Pasted text #1 +3 lines] and [Pasted text #9]', store)).toBe(
			'see one\ntwo\nthree\nfour and [Pasted text #9]',
		)
	})

	const known = { attachments: new Set(['[Image #1]', '[Document #2]']), pastes: new Set([2]) }

	it('finds only the markers with something behind them', () => {
		const value = 'x [Image #1][Pasted text #2 +5 lines] [Image #7] [Pasted text #9]'
		expect(chipRanges(value, known)).toEqual([
			{ start: 2, end: 12, text: '[Image #1]' },
			{ start: 12, end: 37, text: '[Pasted text #2 +5 lines]' },
		])
	})

	it('moves a cursor out of a marker toward the way it was heading', () => {
		const ranges = chipRanges('ab [Image #1] cd', known)
		expect(snapOutOfChip(ranges, 6, -1)).toBe(3)
		expect(snapOutOfChip(ranges, 6, 1)).toBe(13)
		expect(snapOutOfChip(ranges, 4, 0)).toBe(3)
		expect(snapOutOfChip(ranges, 11, 0)).toBe(13)
		expect(snapOutOfChip(ranges, 3, 1)).toBe(3)
		expect(snapOutOfChip(ranges, 13, -1)).toBe(13)
	})

	it('grows a deletion to take a whole marker, and puts typing after one', () => {
		const value = 'ab [Image #1] cd'
		const ranges = chipRanges(value, known)
		expect(widenOverChips(ranges, 5, 9)).toEqual([3, 13])
		expect(widenOverChips(ranges, 0, 2)).toEqual([0, 2])
		expect(keepChipsWhole(value, ranges, { start: 5, deleteEnd: 6 }, '', 5)).toEqual({
			value: 'ab  cd',
			cursor: 3,
		})
		expect(keepChipsWhole(value, ranges, { start: 6, deleteEnd: 6 }, 'z', 7)).toEqual({
			value: 'ab [Image #1]z cd',
			cursor: 14,
		})
	})

	it('pairs the markers a message names with its attachments, in order', () => {
		expect(
			numberAttachments('look [Image #3] and [Document #4]', ['Image', 'Document'], 0),
		).toEqual([3, 4])
		expect(numberAttachments('[Image #5] [Image #3]', ['Image', 'Image'], 0)).toEqual([3, 5])
	})

	it('numbers after the floor when the text does not name them', () => {
		expect(numberAttachments('no markers', ['Image', 'Image'], 4)).toEqual([5, 6])
		expect(numberAttachments('typed [Image #9] by hand', ['Image', 'Image'], 2)).toEqual([10, 11])
		expect(highestAttachmentNumber('[Image #2] [Document #7] [Pasted text #9]')).toBe(7)
	})
})
