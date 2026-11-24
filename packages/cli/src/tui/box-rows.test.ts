import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { BOX_MIN_COLUMNS, type BoxRow, boxColour, boxText, layoutBox } from './box-rows.js'
import type { DisplayLine } from './markdown-wrap.js'

const plain = (line: DisplayLine): string => line.map((span) => span.text).join('')
const width = (line: DisplayLine): number => stringWidth(plain(line))

const box: BoxRow = {
	tone: 'red',
	title: [{ text: 'Task #2 assigned by lead' }],
	body: [[{ text: 'Write part two', bold: true }]],
	notes: [[{ text: 'two sections with a short example in each' }]],
}

describe('a bordered box', () => {
	it('has a rounded border, a bold title and every line the same width', () => {
		const lines = layoutBox(box, 80)
		expect(plain(lines[0] as DisplayLine)).toMatch(/^╭─+╮$/u)
		expect(plain(lines.at(-1) as DisplayLine)).toMatch(/^╰─+╯$/u)
		expect(lines.slice(1, -1).map(plain)).toEqual([
			expect.stringMatching(/^│ Task #2 assigned by lead\s+│$/u),
			expect.stringMatching(/^│ Write part two\s+│$/u),
			expect.stringMatching(/^│ two sections with a short example in each │$/u),
		])
		expect(new Set(lines.map(width)).size).toBe(1)
		const title = lines[1]?.find((span) => span.text.includes('Task'))
		expect(title).toMatchObject({ bold: true, tone: 'red' })
		// The border wears the tone, the footnote is dim.
		expect(lines[0]?.[0]).toMatchObject({ tone: 'red' })
		expect(lines[3]?.some((span) => span.muted === true)).toBe(true)
	})

	it('is no wider than its longest line', () => {
		const lines = layoutBox({ tone: 'red', title: [{ text: 'Short' }] }, 100)
		expect(width(lines[0] as DisplayLine)).toBe('Short'.length + 4)
	})

	it('wraps long lines inside the border and never past the width', () => {
		const long: BoxRow = {
			tone: 'red',
			title: [{ text: 'Plan approval request from @one' }],
			body: [[{ text: 'word '.repeat(40).trim() }]],
		}
		const lines = layoutBox(long, 50)
		expect(lines.length).toBeGreaterThan(5)
		for (const line of lines) expect(width(line)).toBeLessThanOrEqual(50)
		expect(new Set(lines.map(width)).size).toBe(1)
		for (const line of lines.slice(1, -1)) expect(plain(line)).toMatch(/^│ .* │$/u)
	})

	it('keeps a blank body line as a blank line inside the border', () => {
		const lines = layoutBox(
			{ tone: 'red', title: [{ text: 'T' }], body: [[{ text: 'a' }], [], [{ text: 'b' }]] },
			60,
		)
		expect(lines.map(plain)[3]).toMatch(/^│\s+│$/u)
	})

	it('draws no border under 40 columns: an indented block, the notes still dim', () => {
		const lines = layoutBox(box, BOX_MIN_COLUMNS - 1)
		const text = lines.map(plain)
		expect(text.some((line) => /[╭╮╰╯│─]/u.test(line))).toBe(false)
		expect(text[0]).toBe('Task #2 assigned by lead')
		expect(text[1]).toBe('  Write part two')
		expect(text[2]?.startsWith('  two sections')).toBe(true)
		expect(lines[0]?.[0]).toMatchObject({ bold: true })
		for (const line of lines) expect(width(line)).toBeLessThanOrEqual(BOX_MIN_COLUMNS - 1)
		expect(layoutBox(box, BOX_MIN_COLUMNS).some((line) => plain(line).startsWith('╭'))).toBe(true)
	})

	it('keeps the border but gives it and the title no colour where colour is off', () => {
		const lines = layoutBox(box, 80, { colour: false })
		for (const line of lines) for (const span of line) expect(span.tone).toBeUndefined()
		expect(plain(lines[0] as DisplayLine)).toMatch(/^╭─+╮$/u)
		expect(lines[1]?.some((span) => span.bold === true)).toBe(true)
	})

	it('reads NO_COLOR, FORCE_COLOR=0 and a dumb terminal as no colour', () => {
		expect(boxColour({})).toBe(true)
		expect(boxColour({ NO_COLOR: '1' })).toBe(false)
		expect(boxColour({ FORCE_COLOR: '0' })).toBe(false)
		expect(boxColour({ TERM: 'dumb' })).toBe(false)
		expect(boxColour({ NO_COLOR: '' })).toBe(true)
	})

	it('has the same words as plain text for copy and search', () => {
		expect(boxText(box)).toBe(
			'Task #2 assigned by lead\nWrite part two\ntwo sections with a short example in each',
		)
	})

	it('uses only single-cell border glyphs', () => {
		for (const line of layoutBox(box, 80)) {
			for (const span of line) expect(/\p{Extended_Pictographic}/u.test(span.text)).toBe(false)
		}
		expect(stringWidth('╭─╮│╰╯')).toBe(6)
	})
})
