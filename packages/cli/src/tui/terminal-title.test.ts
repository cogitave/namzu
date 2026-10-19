import { describe, expect, it } from 'vitest'

import {
	BUSY_TITLE_GLYPH,
	DEFAULT_TERMINAL_TITLE,
	IDLE_TITLE_GLYPH,
	RESET_TERMINAL_TITLE_SEQUENCE,
	setTerminalTitleSequence,
	terminalTitleEnabled,
	terminalTitleText,
} from './terminal-title.js'

describe('the terminal title text', () => {
	it('says the product name before a conversation has a name', () => {
		expect(terminalTitleText({ busy: false })).toBe(`${IDLE_TITLE_GLYPH} ${DEFAULT_TERMINAL_TITLE}`)
	})

	it('prefers a name a person gave over the title the model wrote', () => {
		expect(
			terminalTitleText({
				named: 'my name',
				generated: 'Model title',
				busy: false,
			}),
		).toBe(`${IDLE_TITLE_GLYPH} my name`)
	})

	it('uses the model title when there is no chosen name', () => {
		expect(terminalTitleText({ generated: 'Model title', busy: false })).toBe(
			`${IDLE_TITLE_GLYPH} Model title`,
		)
	})

	it('shows a different glyph while a turn runs', () => {
		expect(terminalTitleText({ generated: 'Model title', busy: true })).toBe(
			`${BUSY_TITLE_GLYPH} Model title`,
		)
	})

	it('ignores a blank name', () => {
		expect(
			terminalTitleText({
				named: '   ',
				generated: 'Model title',
				busy: false,
			}),
		).toBe(`${IDLE_TITLE_GLYPH} Model title`)
	})

	it('keeps control characters out, so a name cannot end the sequence early', () => {
		const text = terminalTitleText({
			named: 'a\u0007b\u001b]0;evil',
			busy: false,
		})
		expect([...text].some((char) => char < ' ')).toBe(false)
		expect(setTerminalTitleSequence(text)).toBe(`\u001b]0;${text}\u0007`)
	})

	it('cuts a very long name', () => {
		const text = terminalTitleText({ named: 'x'.repeat(500), busy: false })
		expect(text.length).toBeLessThanOrEqual(104)
	})
})

describe('the title sequences', () => {
	it('sets window title and icon name with OSC 0, ended by BEL', () => {
		expect(setTerminalTitleSequence('✳ Namzu')).toBe('\u001b]0;✳ Namzu\u0007')
	})

	it('resets with an empty OSC 0', () => {
		expect(RESET_TERMINAL_TITLE_SEQUENCE).toBe('\u001b]0;\u0007')
	})
})

describe('when the title is written', () => {
	it('writes only to a terminal', () => {
		expect(terminalTitleEnabled({}, true)).toBe(true)
		expect(terminalTitleEnabled({}, false)).toBe(false)
		expect(terminalTitleEnabled({}, undefined)).toBe(false)
	})

	it('is switched off by NAMZU_DISABLE_TERMINAL_TITLE', () => {
		expect(terminalTitleEnabled({ NAMZU_DISABLE_TERMINAL_TITLE: '1' }, true)).toBe(false)
		expect(terminalTitleEnabled({ NAMZU_DISABLE_TERMINAL_TITLE: 'true' }, true)).toBe(false)
		expect(terminalTitleEnabled({ NAMZU_DISABLE_TERMINAL_TITLE: '0' }, true)).toBe(true)
		expect(terminalTitleEnabled({ NAMZU_DISABLE_TERMINAL_TITLE: '' }, true)).toBe(true)
	})
})
