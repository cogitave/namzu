import { describe, expect, it } from 'vitest'

import {
	USER_TEXT_EDGE,
	USER_TEXT_LIMIT,
	cutUserText,
	hiddenTextNote,
	hiddenTextRule,
} from './user-text-view.js'

describe('the echo of a message the person sent', () => {
	it('shows a message of 10,000 characters or fewer whole, pasted lines included', () => {
		const forty = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1}`).join('\n')
		expect(cutUserText(forty)).toBe(forty)
		expect(cutUserText('x'.repeat(USER_TEXT_LIMIT))).toBe('x'.repeat(USER_TEXT_LIMIT))
	})

	it('keeps 2,500 characters at each end of a longer message and counts what lies between', () => {
		const text = `${'a'.repeat(USER_TEXT_EDGE)}\n${'b\n'.repeat(6_000)}${'c'.repeat(USER_TEXT_EDGE)}`
		const cut = cutUserText(text)
		if (typeof cut === 'string') throw new Error('expected a cut')
		expect(cut.head).toBe('a'.repeat(USER_TEXT_EDGE))
		expect(cut.tail).toBe('c'.repeat(USER_TEXT_EDGE))
		expect(cut.hiddenChars).toBe(text.length - 2 * USER_TEXT_EDGE)
		expect(cut.hiddenLines).toBe(6_001)
	})

	it('does not split an emoji at either edge', () => {
		const text = `${'a'.repeat(USER_TEXT_EDGE - 1)}😀${'m'.repeat(USER_TEXT_LIMIT)}😀${'z'.repeat(USER_TEXT_EDGE - 1)}`
		const cut = cutUserText(text)
		if (typeof cut === 'string') throw new Error('expected a cut')
		for (const part of [cut.head, cut.tail]) {
			expect(part).not.toMatch(/[\ud800-\udbff]$/u)
			expect(part).not.toMatch(/^[\udc00-\udfff]/u)
		}
	})

	it('names the hidden part in plain words', () => {
		expect(hiddenTextNote({ hiddenLines: 12, hiddenChars: 34_400 })).toBe(
			'(12 lines, ~34 KB hidden)',
		)
		expect(hiddenTextNote({ hiddenLines: 1, hiddenChars: 100 })).toBe('(1 line, ~1 KB hidden)')
		expect(hiddenTextNote({ hiddenLines: 0, hiddenChars: 7_000 })).toBe('(~7 KB hidden)')
	})

	it('draws the divider out to the width it is given', () => {
		const rule = hiddenTextRule('(12 lines, ~34 KB hidden)', 60)
		expect(rule.startsWith('──── (12 lines, ~34 KB hidden) ─')).toBe(true)
		expect([...rule]).toHaveLength(60)
	})
})
