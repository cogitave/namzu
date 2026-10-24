import { describe, expect, it } from 'vitest'

import { chipBefore, expandChips, isChipPaste, pasteChip, pasteChipLines } from './paste-chips.js'

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

	it('finds a chip that ends at the cursor', () => {
		const value = 'x [Image #1][Pasted text #2 +5 lines]'
		expect(chipBefore(value, value.length)).toEqual({
			start: 12,
			chip: '[Pasted text #2 +5 lines]',
		})
		expect(chipBefore(value, 12)).toEqual({ start: 2, chip: '[Image #1]' })
		expect(chipBefore(value, 1)).toBeNull()
	})
})
