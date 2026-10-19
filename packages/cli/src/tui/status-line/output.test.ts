import { describe, expect, it } from 'vitest'

import { carryStyleAcrossLines, sanitiseStatusLineOutput } from './output.js'

describe('sanitiseStatusLineOutput', () => {
	it('trims, trims each line and drops blank ones', () => {
		expect(sanitiseStatusLineOutput('\n  one  \n\n   \ntwo\n\n')).toBe('one\ntwo')
	})

	it('is nothing for empty or blank output', () => {
		expect(sanitiseStatusLineOutput('')).toBeUndefined()
		expect(sanitiseStatusLineOutput('  \n \n')).toBeUndefined()
	})

	it('keeps colours and links but drops cursor moves, clears and other controls', () => {
		const coloured = '\x1b[32mok\x1b[0m \x1b]8;;https://x.test\x07link\x1b]8;;\x07'
		expect(sanitiseStatusLineOutput(coloured)).toBe(coloured)
		expect(sanitiseStatusLineOutput('a\x1b[2J\x1b[Hb\x07c\x1b]0;title\x07d\x00e')).toBe('abcde')
	})

	it('reads CRLF as line ends', () => {
		expect(sanitiseStatusLineOutput('a\r\nb\r\n')).toBe('a\nb')
	})
})

describe('carryStyleAcrossLines', () => {
	it('leaves a single line alone', () => {
		expect(carryStyleAcrossLines('plain')).toEqual(['plain'])
	})

	it('repeats the colours of earlier lines at the start of each later one', () => {
		expect(carryStyleAcrossLines('\x1b[31mred\nstill\x1b[0m\nlast')).toEqual([
			'\x1b[31mred',
			'\x1b[31mstill\x1b[0m',
			'\x1b[31m\x1b[0mlast',
		])
	})
})
