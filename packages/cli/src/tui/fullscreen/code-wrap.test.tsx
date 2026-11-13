/**
 * A code line is cut as Ink's own wrapper cuts it, and the rows of a code block
 * can be made while a window is being rendered.
 */

import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import stringWidth from 'string-width'

import { wrapCodeLine } from './code-wrap.js'

/** What the normal transcript draws for the line: Ink's `<Text wrap="wrap">`, asked outside a render. */
function inkRows(line: string, width: number): string[] {
	return renderToString(
		<Box width={width}>
			<Text wrap="wrap">{line}</Text>
		</Box>,
		{ columns: width },
	).split('\n')
}

/** A fixed pseudo-random source, so a failure names the line and can be run again. */
function lcg(seed: number) {
	let state = seed
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296
		return state / 4294967296
	}
}

const PIECES = [
	'a',
	'bc',
	'const',
	'function',
	'    ',
	' ',
	'  ',
	'(',
	')',
	'=>',
	'{',
	'"text"',
	'https://example.com/a/very/long/address/that/does/not/fit',
	'世界',
	'é',
	'🙂',
	'\t',
	'x'.repeat(30),
	'0123456789',
]

describe('wrapCodeLine', () => {
	it('leaves a line that fits as written, blanks and all', () => {
		expect(wrapCodeLine('  const a = 1  ', 40)).toEqual(['  const a = 1  '])
		expect(wrapCodeLine('', 10)).toEqual([''])
	})

	it('cuts at a space (the blank stays at the head of the next row, as Ink keeps it), and breaks a word wider than a row between graphemes', () => {
		expect(wrapCodeLine('alpha beta gamma', 10)).toEqual(['alpha beta', ' gamma'])
		expect(wrapCodeLine('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
		expect(wrapCodeLine('世界世界世', 4)).toEqual(['世界', '世界', '世'])
	})

	it('gives the rows Ink draws, over many lines and widths', () => {
		const next = lcg(7)
		let compared = 0
		for (let n = 0; n < 400; n++) {
			const count = 1 + Math.floor(next() * 14)
			let line = ''
			for (let i = 0; i < count; i++) line += PIECES[Math.floor(next() * PIECES.length)]
			const width = 3 + Math.floor(next() * 38)
			// A line that fits is never cut, so it is never asked of the renderer either.
			if (stringWidth(line) <= width) continue
			compared += 1
			expect(wrapCodeLine(line, width), `${JSON.stringify(line)} at ${width}`).toEqual(
				inkRows(line, width),
			)
		}
		expect(compared).toBeGreaterThan(200)
	})
})
