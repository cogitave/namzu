import { describe, expect, it } from 'vitest'
import { WINDOW_HALF_CHARS, windowText } from './text-window.js'

describe('retained text windows', () => {
	it('keeps a short sliced body exact and measures the original UTF-8 bytes', () => {
		const body = 'baş\ud800x\udfff🦉\u0000son'
		const parent = `${'x'.repeat(100_000)}${body}\n${'y'.repeat(100_000)}`
		const text = parent.slice(100_000, 100_000 + body.length + 1)
		expect(windowText(text)).toEqual({
			head: body,
			totalLines: 1,
			totalBytes: Buffer.byteLength(text, 'utf8'),
		})
	})

	it('keeps bounded head and tail code units without changing source byte metadata', () => {
		const text = `head\ud800${'x'.repeat(10_000)}\n${'middle\n'.repeat(130)}${'y'.repeat(10_000)}\udffftail`
		const window = windowText(text)
		expect(window.head).toMatch(/^head\ud800/)
		expect(window.tail).toMatch(/\udffftail$/)
		expect(window.head.length).toBeLessThanOrEqual(WINDOW_HALF_CHARS + 1)
		expect(window.tail?.length).toBeLessThanOrEqual(WINDOW_HALF_CHARS + 1)
		expect(window.totalBytes).toBe(Buffer.byteLength(text, 'utf8'))
		expect(window.omittedLines).toBeGreaterThan(0)
	})
})
