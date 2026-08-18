import { describe, expect, it, vi } from 'vitest'

import { MAX_CLIPBOARD_TEXT_BYTES, writeClipboardText } from './text.js'

describe('writeClipboardText', () => {
	it('writes one bounded OSC 52 request containing the exact UTF-8 text', () => {
		const write = vi.fn()
		const text = '# Result\n\n**tam** ✓\n\x1b]52;c;INJECTED\x07'

		expect(writeClipboardText(text, { isTTY: true, write })).toEqual({
			kind: 'request-sent',
			bytes: Buffer.byteLength(text, 'utf8'),
		})
		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith(
			`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`,
		)
		// The model-authored escape is encoded, never executable inside the OSC.
		expect(write.mock.calls[0]?.[0]).not.toContain('INJECTED\x07')
	})

	it('refuses a non-interactive stdout before writing anything', () => {
		const write = vi.fn()

		expect(writeClipboardText('answer', { isTTY: false, write })).toEqual({
			kind: 'unavailable',
			detail: 'stdout is not an interactive terminal',
		})
		expect(write).not.toHaveBeenCalled()
	})

	it('accepts the stated byte limit exactly', () => {
		const write = vi.fn()
		const text = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES)

		expect(writeClipboardText(text, { isTTY: true, write })).toEqual({
			kind: 'request-sent',
			bytes: MAX_CLIPBOARD_TEXT_BYTES,
		})
		expect(write).toHaveBeenCalledTimes(1)
	})

	it('refuses one byte over the limit instead of truncating', () => {
		const write = vi.fn()
		const text = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)

		expect(writeClipboardText(text, { isTTY: true, write })).toEqual({
			kind: 'too-large',
			bytes: MAX_CLIPBOARD_TEXT_BYTES + 1,
			limit: MAX_CLIPBOARD_TEXT_BYTES,
		})
		expect(write).not.toHaveBeenCalled()
	})

	it('reports only that the request could not be sent when Ink stdout throws', () => {
		const write = vi.fn(() => {
			throw new Error('stream closed')
		})

		expect(writeClipboardText('answer', { isTTY: true, write })).toEqual({
			kind: 'write-failed',
			detail: 'stream closed',
		})
	})
})
