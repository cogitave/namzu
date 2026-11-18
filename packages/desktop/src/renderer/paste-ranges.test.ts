import { describe, expect, it } from 'vitest'

import { addPaste, confirmedRanges, isMaterialPaste, trackEdit } from './paste-ranges.js'

const PASTE = 'line one\nline two\nline three\nline four'

describe('which pastes are material', () => {
	it('is a long paste or one of several lines, not a word or a short line', () => {
		expect(isMaterialPaste('hello')).toBe(false)
		expect(isMaterialPaste('a\nb\nc')).toBe(false)
		expect(isMaterialPaste('a\nb\nc\nd')).toBe(true)
		expect(isMaterialPaste('x'.repeat(801))).toBe(true)
	})
})

describe('pasted stretches while the person edits', () => {
	const before = 'summarise: '
	const box = before + PASTE
	const ranges = addPaste([], box, before.length, PASTE)

	it('records where the paste landed', () => {
		expect(ranges).toEqual([{ start: 11, end: 11 + PASTE.length, text: PASTE }])
	})

	it('keeps a stretch when typing happens before or after it', () => {
		const earlier = trackEdit(ranges, box, `please ${box}`)
		expect(earlier[0]).toMatchObject({ start: 18, end: 18 + PASTE.length })
		const later = trackEdit(ranges, box, `${box} thanks`)
		expect(later).toEqual(ranges)
		expect(confirmedRanges(earlier, `please ${box}`)).toEqual([
			{ start: 18, end: 18 + PASTE.length },
		])
	})

	it('drops a stretch an edit reaches into', () => {
		const edited = box.replace('line two', 'line 2')
		expect(trackEdit(ranges, box, edited)).toEqual([])
	})

	it('never trusts a stretch that no longer holds the pasted text', () => {
		expect(confirmedRanges(ranges, `XX${box}`)).toEqual([])
		expect(confirmedRanges(undefined, box)).toEqual([])
	})

	it('keeps as much as the box held when it cut the paste at its limit', () => {
		const cut = before + PASTE.slice(0, 20)
		expect(addPaste([], cut, before.length, PASTE)).toEqual([
			{ start: 11, end: 31, text: PASTE.slice(0, 20) },
		])
		expect(addPaste([], before, before.length, PASTE)).toEqual([])
	})

	it('is empty once the box is cleared', () => {
		expect(trackEdit(ranges, box, '')).toEqual([])
	})
})
