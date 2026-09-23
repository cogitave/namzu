import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import {
	type DisplayLine,
	inlineDisplaySpans,
	longestWordWidth,
	wrapSpans,
} from './markdown-wrap.js'

const text = (line: DisplayLine) => line.map((span) => span.text).join('')
const rows = (source: string, width: number) => wrapSpans([{ text: source }], width).map(text)

describe('wrapSpans', () => {
	it('never starts a wrapped row with the space it broke at', () => {
		// Ink's own wrap put this space at the start of the next row: `" bbbb"`,
		// and a word exactly as wide as the row left a row of one space.
		expect(rows('aaaa bbbb cccc', 4)).toEqual(['aaaa', 'bbbb', 'cccc'])
		expect(rows('Kullanılan yapı araştır. Cevabı', 24)).toEqual([
			'Kullanılan yapı araştır.',
			'Cevabı',
		])
	})

	it('keeps every row within the width at 40, 80, 120 and 160 columns, Turkish included', () => {
		const prose =
			"OpenClaw'ın native agent runtime'ı hangi framework ya da harness üzerine kurulu? Web'de birkaç kaynaktan araştır. Cevabı kısa bir paragrafla ver, sonra 'Net stack' başlığı altında iki sütunlu bir markdown tablosu ver."
		for (const width of [40, 80, 120, 160]) {
			const wrapped = rows(prose, width)
			for (const row of wrapped) {
				expect(stringWidth(row)).toBeLessThanOrEqual(width)
				expect(row.startsWith(' ')).toBe(false)
			}
			// Nothing lost and nothing added but the breaks.
			expect(wrapped.join(' ')).toBe(prose)
		}
	})

	it('continues a word longer than the row on the next row instead of cutting it', () => {
		const url =
			'https://docs.openclaw.ai/agent-runtime-architecture/and/a/very/long/path?with=query'
		const wrapped = rows(`see ${url} now`, 30)
		for (const row of wrapped) expect(stringWidth(row)).toBeLessThanOrEqual(30)
		expect(wrapped.join('').replace(/\s/g, '')).toBe(`see${url}now`)
		expect(wrapped[0]?.startsWith('see https://')).toBe(true)
	})

	it('measures wide characters in cells and never splits a grapheme', () => {
		const wrapped = rows('漢字漢字漢字 👩‍👩‍👧 ok', 5)
		for (const row of wrapped) expect(stringWidth(row)).toBeLessThanOrEqual(5)
		expect(wrapped).toContain('👩‍👩‍👧 ok')
		expect(wrapped.slice(0, 3)).toEqual(['漢字', '漢字', '漢字'])
	})

	it('keeps a line’s own indentation and breaks at every newline', () => {
		expect(rows('first\n  indented line', 40)).toEqual(['first', '  indented line'])
		expect(rows('a\n\nb', 10)).toEqual(['a', '', 'b'])
	})

	it('draws a tab as the spaces it takes, so the row is measured as drawn', () => {
		const [row] = wrapSpans([{ text: 'a\tb' }], 20)
		expect(text(row ?? [])).toBe('a    b')
	})

	it('keeps each span’s style on the pieces it is split into', () => {
		const wrapped = wrapSpans(inlineDisplaySpans('plain **bold words here** end', false), 12)
		const bold = wrapped.flatMap((line) =>
			line.filter((span) => span.bold).map((span) => span.text),
		)
		expect(bold.join(' ')).toBe('bold words here')
	})
})

describe('inlineDisplaySpans', () => {
	it('puts a link’s address after its label unless the terminal draws the link', () => {
		expect(inlineDisplaySpans('[docs](https://example.com)', false).map((s) => s.text)).toEqual([
			'docs',
			' (https://example.com)',
		])
		expect(inlineDisplaySpans('[docs](https://example.com)', true).map((s) => s.text)).toEqual([
			'docs',
		])
		// A target the terminal would refuse keeps its address visible.
		expect(inlineDisplaySpans('[docs](file:///etc/passwd)', true).map((s) => s.text)).toEqual([
			'docs',
			' (file:///etc/passwd)',
		])
	})
})

describe('longestWordWidth', () => {
	it('is the widest word in cells', () => {
		expect(longestWordWidth([{ text: 'a bbb 漢字漢' }])).toBe(6)
	})
})
