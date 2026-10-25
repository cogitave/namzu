import { describe, expect, it } from 'vitest'
import { clipText, hiddenLinesHint } from './truncation.js'

describe('the one truncation wording', () => {
	it('says how many lines are folded and how to open them', () => {
		expect(hiddenLinesHint(12)).toBe('… +12 lines (ctrl+o to expand)')
		expect(hiddenLinesHint(1)).toBe('… +1 line (ctrl+o to expand)')
		expect(hiddenLinesHint(1200)).toBe('… +1,200 lines (ctrl+o to expand)')
	})

	it('sizes the hidden text from 1,000 characters', () => {
		expect(hiddenLinesHint(5, { chars: 999 })).toBe('… +5 lines (ctrl+o to expand)')
		expect(hiddenLinesHint(5, { chars: 3072 })).toBe('… +5 lines (ctrl+o to expand) (~3 KB)')
		expect(hiddenLinesHint(5, { chars: 1000 })).toBe('… +5 lines (ctrl+o to expand) (~1 KB)')
	})

	it('does not promise an expansion nothing can give', () => {
		expect(hiddenLinesHint(3, { canExpand: false })).toBe('… +3 lines')
	})
})

describe('clipping a preview', () => {
	it('leaves short text alone', () => {
		expect(clipText('short', 10)).toBe('short')
	})

	it('cuts to the limit with an ellipsis', () => {
		expect(clipText('abcdefghij', 5)).toBe('abcd…')
	})

	it('never splits an emoji at the cut', () => {
		const text = `${'a'.repeat(3)}😀tail`
		const clipped = clipText(text, 5)
		expect(clipped).toBe('aaa…')
		expect(clipped).not.toMatch(/[\uD800-\uDBFF]/)
	})
})
