import { describe, expect, it } from 'vitest'
import { streamParts } from './tool-output-view.js'
import {
	cleanTerminalText,
	collapseOutput,
	humanBytes,
	looksBinaryText,
	outputSpans,
	plainTerminalText,
} from './tool-output.js'

describe('colour', () => {
	it('draws the sixteen colours as classes and keeps the words', () => {
		const spans = outputSpans(
			'\u001b[31mred\u001b[0m \u001b[1;32mgreen\u001b[0m \u001b[4mund\u001b[0m',
		)
		expect(spans.map((span) => span.text)).toEqual(['red', ' ', 'green', ' ', 'und'])
		expect(spans[0]).toMatchObject({ fg: 'ansi-red' })
		expect(spans[2]).toMatchObject({ fg: 'ansi-green', bold: true })
		expect(spans[4]).toMatchObject({ underline: true })
	})

	it('turns a 256-colour entry into the colour it names', () => {
		const [span] = outputSpans('\u001b[38;5;208morange\u001b[0m')
		expect(span).toMatchObject({ text: 'orange', fgRgb: '255, 135, 0' })
	})

	it('names a background by its own class, not the foreground one', () => {
		const [span] = outputSpans('\u001b[42mon green\u001b[0m')
		expect(span?.bg).toBe('ansi-bg-green')
		expect(span?.fg).toBeUndefined()
	})

	it('strips every escape for a tooltip or a screen reader', () => {
		const text = '\u001b[31mred\u001b[0m \u001b[2K\u001b[1Gline\u001b]0;title\u0007 end'
		expect(plainTerminalText(text)).toBe('red line end')
		expect(plainTerminalText(text)).not.toContain('\u001b')
	})

	it('keeps Turkish letters and emoji intact', () => {
		expect(plainTerminalText('\u001b[32mşğüöçıİ 😀\u001b[0m')).toBe('şğüöçıİ 😀')
	})
})

describe('a rewritten line', () => {
	it('shows only what the last carriage return left', () => {
		expect(cleanTerminalText('10%\r50%\r100%\ndone')).toBe('100%\ndone')
		expect(cleanTerminalText('a\r\nb')).toBe('a\nb')
	})

	it('does not erase a line that only ends in a carriage return', () => {
		expect(cleanTerminalText('progress\r')).toBe('progress\r')
	})
})

describe('binary', () => {
	it('recognises bytes and not text', () => {
		expect(looksBinaryText('abc\u0000def')).toBe(true)
		expect(looksBinaryText('�'.repeat(30) + 'a'.repeat(30))).toBe(true)
		expect(looksBinaryText('\u001b[31mkırmızı\u001b[0m\n\tşğü')).toBe(false)
		expect(looksBinaryText('')).toBe(false)
	})
})

describe('sizes', () => {
	it('writes a size a person reads', () => {
		expect(humanBytes(0)).toBe('0 B')
		expect(humanBytes(900)).toBe('900 B')
		expect(humanBytes(3000)).toBe('3 KB')
		expect(humanBytes(4096)).toBe('4.1 KB')
		expect(humanBytes(1_258_291)).toBe('1.3 MB')
		expect(humanBytes(250_000)).toBe('250 KB')
		expect(humanBytes(-1)).toBe('')
		expect(humanBytes(Number.NaN)).toBe('')
	})
})

describe('folding', () => {
	it('keeps a short output whole', () => {
		expect(collapseOutput('a\nb\nc')).toEqual({
			head: 'a\nb\nc',
			hidden: 0,
			total: 3,
		})
	})

	it('keeps the first and last lines of a long one and counts the rest', () => {
		const text = Array.from({ length: 600 }, (_, i) => String(i + 1)).join('\n')
		const folded = collapseOutput(text)
		expect(folded.head.split('\n')).toHaveLength(8)
		expect(folded.tail?.split('\n').at(-1)).toBe('600')
		expect(folded.hidden).toBe(588)
	})
})

describe('a stream as the SDK windowed it', () => {
	it('is not expandable when it fits', () => {
		expect(streamParts({ head: 'a\nb', omitted: 0, total: 2 })).toMatchObject({
			expandable: false,
			hidden: 0,
		})
	})

	it('collapses to eight lines, a count and four lines, and expands to the whole window', () => {
		const lines = Array.from({ length: 600 }, (_, i) => String(i + 1))
		const parts = streamParts({
			head: lines.slice(0, 80).join('\n'),
			tail: lines.slice(-40).join('\n'),
			omitted: 480,
			total: 600,
		})
		expect(parts.expandable).toBe(true)
		expect(parts.hidden).toBe(588)
		expect(parts.collapsed).toEqual([
			{ kind: 'text', text: lines.slice(0, 8).join('\n') },
			{ kind: 'gap', lines: 588 },
			{ kind: 'text', text: lines.slice(-4).join('\n') },
		])
		expect(parts.expanded).toEqual([
			{ kind: 'text', text: lines.slice(0, 80).join('\n') },
			{ kind: 'gap', lines: 480 },
			{ kind: 'text', text: lines.slice(-40).join('\n') },
		])
	})

	it('folds a long head with no tail by its own last lines', () => {
		const lines = Array.from({ length: 30 }, (_, i) => String(i + 1))
		const parts = streamParts({
			head: lines.join('\n'),
			omitted: 0,
			total: 30,
		})
		expect(parts.expandable).toBe(true)
		expect(parts.collapsed.at(-1)).toEqual({
			kind: 'text',
			text: lines.slice(-4).join('\n'),
		})
		expect(parts.hidden).toBe(18)
	})
})
