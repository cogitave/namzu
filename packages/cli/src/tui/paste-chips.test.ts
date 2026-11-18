import { describe, expect, it } from 'vitest'

import {
	blankRanges,
	chipRanges,
	expandChips,
	expandChipsWithRanges,
	expandMentionsAround,
	highestAttachmentNumber,
	isChipPaste,
	keepChipsWhole,
	numberAttachments,
	pasteChip,
	pasteChipLines,
	shiftRanges,
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

describe('where a paste lands in the sent text', () => {
	const pastes = new Map([
		[1, 'ONE\nTWO'],
		[2, 'THREE'],
	])

	it('reports the stretch each held paste takes, and leaves a hand-edited chip alone', () => {
		const out = expandChipsWithRanges(
			'a [Pasted text #1 +1 lines] b [Pasted text #2] [Pasted text #9]',
			pastes,
		)
		expect(out.text).toBe('a ONE\nTWO b THREE [Pasted text #9]')
		expect(out.ranges).toEqual([
			{ start: 2, end: 9 },
			{ start: 12, end: 17 },
		])
		for (const range of out.ranges)
			expect(['ONE\nTWO', 'THREE']).toContain(out.text.slice(range.start, range.end))
	})

	it('agrees with expandChips on the text', () => {
		const value = '  x [Pasted text #2] y '
		expect(expandChipsWithRanges(value, pastes).text).toBe(expandChips(value, pastes))
	})

	it('moves with a trim and drops what the trim cuts away', () => {
		expect(shiftRanges([{ start: 2, end: 9 }], 2, 7)).toEqual([{ start: 0, end: 7 }])
		expect(shiftRanges([{ start: 0, end: 2 }], 2, 7)).toEqual([])
	})

	it('blanks pasted stretches without moving anything else', () => {
		expect(blankRanges('see @a.ts PASTE @b.ts', [{ start: 10, end: 15 }])).toBe(
			'see @a.ts       @b.ts',
		)
		expect(blankRanges('same', undefined)).toBe('same')
	})

	it('reads no file mention inside a paste, and still appends what the typed ones bring', () => {
		const seen: string[] = []
		const out = expandMentionsAround(
			'look @typed.ts then @pasted.ts',
			[{ start: 16, end: 30 }],
			(text) => {
				seen.push(text)
				return { sendText: `${text}\n\n<file path="typed.ts">x</file>` }
			},
		)
		expect(seen[0]).not.toContain('@pasted.ts')
		expect(out.sendText.startsWith('look @typed.ts then @pasted.ts\n\n<file')).toBe(true)
	})
})
