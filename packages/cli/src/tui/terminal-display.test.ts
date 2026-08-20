import { describe, expect, it } from 'vitest'

import { terminalDisplayText } from './terminal-display.js'

const cp = (value: number): string => String.fromCodePoint(value)

describe('terminalDisplayText', () => {
	it('keeps printable Unicode, source newlines, tabs and script joiners', () => {
		const source = `Türkçe 🙂\n\tفار${cp(0x200c)}سی 👩${cp(0x200d)}💻`
		expect(terminalDisplayText(source)).toBe(source)
	})

	it('normalizes CRLF and exposes terminal controls and deceptive formatting', () => {
		const source = [
			'a\r\nb',
			cp(0x00),
			cp(0x07),
			cp(0x08),
			cp(0x0d),
			cp(0x1b),
			cp(0x7f),
			cp(0x85),
			cp(0x9b),
			cp(0x9d),
			cp(0x9c),
			cp(0x2028),
			cp(0x2029),
			cp(0x061c),
			cp(0x200b),
			cp(0x200e),
			cp(0x200f),
			cp(0x202e),
			cp(0x2060),
			cp(0x2064),
			cp(0x2066),
			cp(0x206f),
			cp(0xfeff),
		].join('')

		expect(terminalDisplayText(source)).toBe(
			'a\nb' +
				'\\u{0000}\\u{0007}\\u{0008}\\u{000d}\\u{001b}\\u{007f}' +
				'\\u{0085}\\u{009b}\\u{009d}\\u{009c}\\u{2028}\\u{2029}' +
				'\\u{061c}\\u{200b}\\u{200e}\\u{200f}\\u{202e}' +
				'\\u{2060}\\u{2064}\\u{2066}\\u{206f}\\u{feff}',
		)
	})

	it('is idempotent, so layered render boundaries do not rewrite the view twice', () => {
		const once = terminalDisplayText(`before${cp(0x1b)}after${cp(0x202e)}`)
		expect(terminalDisplayText(once)).toBe(once)
	})
})
