import { describe, expect, it, vi } from 'vitest'

import { MAX_CLIPBOARD_TEXT_BYTES, buildClipboardSequence, writeClipboardText } from './text.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const FRAME = new RegExp(`${ESC}P${ESC}\\]52;c;([^${BEL}]*)${BEL}${ESC}\\\\`, 'gu')
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('buildClipboardSequence', () => {
	it('writes the plain form outside a multiplexer', () => {
		expect(buildClipboardSequence('hello', {})).toBe(`\x1b]52;c;${b64('hello')}\x07`)
		expect(buildClipboardSequence('hello', { TERM: 'xterm-256color' })).toBe(
			`\x1b]52;c;${b64('hello')}\x07`,
		)
	})

	it('wraps for tmux with every escape doubled inside a passthrough frame', () => {
		const out = buildClipboardSequence('hello', { TMUX: '/tmp/tmux-1000/default,1,0' })
		expect(out).toBe(`\x1bPtmux;\x1b\x1b]52;c;${b64('hello')}\x07\x1b\\`)
	})

	it('cuts the payload into 76-character frames for screen and the pieces rejoin', () => {
		const text = 'ç'.repeat(200)
		for (const env of [{ STY: '123.pts-0.host' }, { TERM: 'screen-256color' }]) {
			const out = buildClipboardSequence(text, env)
			const frames = [...out.matchAll(FRAME)].map((m) => m[1])
			expect(frames.length).toBeGreaterThan(1)
			for (const frame of frames) expect((frame as string).length).toBeLessThanOrEqual(76)
			expect(Buffer.from(frames.join(''), 'base64').toString('utf8')).toBe(text)
		}
	})

	it('keeps non-ASCII text intact', () => {
		const text = 'tamam ✓ 日本語 🙂'
		const out = buildClipboardSequence(text, {})
		const encoded = out.slice('\x1b]52;c;'.length, -1)
		expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(text)
	})
})

describe('writeClipboardText limits', () => {
	it('sends at the cap and refuses above it without truncating', () => {
		const write = vi.fn()
		const atCap = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES)
		expect(writeClipboardText(atCap, { isTTY: true, write }, {}).kind).toBe('request-sent')
		write.mockClear()
		expect(writeClipboardText(`${atCap}a`, { isTTY: true, write }, {})).toEqual({
			kind: 'too-large',
			bytes: MAX_CLIPBOARD_TEXT_BYTES + 1,
			limit: MAX_CLIPBOARD_TEXT_BYTES,
		})
		expect(write).not.toHaveBeenCalled()
	})

	it('uses the wrapped form for tmux', () => {
		const write = vi.fn()
		writeClipboardText('x', { isTTY: true, write }, { TMUX: '1' })
		expect(write.mock.calls[0]?.[0]).toContain('\x1bPtmux;')
	})
})
