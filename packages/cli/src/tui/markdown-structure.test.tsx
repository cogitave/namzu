import { Box, renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { ContentWidth, Markdown } from './Markdown.js'
import { markdownRows } from './fullscreen/markdown-rows.js'
import { headingStyle, ruleWidth } from './markdown-structure.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes to read the text
const ANSI = /\u001b\[[0-9;]*m/gu
const plain = (s: string): string => s.replace(ANSI, '')

function draw(text: string, width: number): string[] {
	return plain(
		renderToString(
			<ContentWidth.Provider value={width}>
				<Box width={width}>
					<Markdown text={text} />
				</Box>
			</ContentWidth.Provider>,
			{ columns: width },
		),
	)
		.split('\n')
		.map((row) => row.replace(/ +$/u, ''))
}

const LONG =
	'a quoted paragraph that is long enough to need more than one row on a narrow screen, with `code` and **bold** inside it'

const REPLY = [
	'# One',
	'## Two',
	'### Three',
	'#### Four',
	'##### Five',
	'###### Six',
	'',
	`> ${LONG}`,
	'>',
	'> - first',
	'> - second',
	'>',
	'> > nested quote',
	'',
	'---',
	'',
	'| a | b |',
	'| - | - |',
	'| 1 | 2 |',
	'',
	'```',
	'> kept',
	'---',
	'```',
	'',
	'a > b stays text',
].join('\n')

describe('headings, quotes and rules as drawn', () => {
	for (const width of [40, 80, 120]) {
		describe(`at ${width} columns`, () => {
			const rows = draw(REPLY, width)

			it('draws no row wider than the width', () => {
				for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(width)
			})

			it('puts the bar on every row of a quote, wrapped rows included', () => {
				const first = rows.findIndex((r) => r.startsWith('│ a quoted'))
				const last = rows.findIndex((r) => r.startsWith('│ │ nested'))
				expect(first).toBeGreaterThan(-1)
				expect(last).toBeGreaterThan(first)
				for (const row of rows.slice(first, last + 1)) expect(row.startsWith('│')).toBe(true)
				// The empty ">" lines are rows with a bar and nothing else.
				expect(rows.slice(first, last + 1).filter((r) => r === '│').length).toBe(2)
				if (width === 40) {
					expect(
						rows.slice(first).findIndex((r) => r.startsWith('│ ') && !r.includes('a quoted')),
					).toBeGreaterThan(0)
				}
			})

			it('draws a rule as a run of the horizontal character, at most 40 wide', () => {
				const rule = rows.find((r) => /^─+$/u.test(r))
				expect(rule).toBeDefined()
				expect(stringWidth(rule ?? '')).toBe(Math.min(40, width))
			})

			it('keeps the table, and the quote and rule marks in a code fence as written', () => {
				expect(rows.some((r) => r.startsWith('┌'))).toBe(true)
				const at = rows.indexOf('> kept')
				expect(at).toBeGreaterThan(-1)
				expect(rows[at + 1]).toBe('---')
				expect(rows).toContain('a > b stays text')
			})

			it('draws the heading texts without their marks', () => {
				for (const word of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) {
					expect(rows).toContain(word)
				}
			})
		})
	}

	it('leaves a blank row above and below a rule', () => {
		expect(draw('a\n\n---\n\nb', 80)).toEqual(['a', '', '─'.repeat(40), '', 'b'])
	})

	it('draws a rule narrower than 40 at the width there is', () => {
		const rows = draw('---', 20)
		expect(rows[0]).toBe('─'.repeat(20))
	})

	it('wraps a quote to the width less the bar', () => {
		const rows = draw('> aaaa bbbb cccc dddd', 12)
		expect(rows).toEqual(['│ aaaa bbbb', '│ cccc dddd'])
	})

	it('puts two bars on a quote in a quote', () => {
		expect(draw('> a\n>\n> > b', 40)).toEqual(['│ a', '│', '│ │ b'])
	})

	it('draws an empty quote as one row with its bar', () => {
		expect(draw('>', 40)).toEqual(['│'])
	})

	it('wraps a long heading as before', () => {
		const rows = draw('## aaaa bbbb cccc dddd', 10)
		expect(rows).toEqual(['aaaa bbbb', 'cccc dddd'])
	})

	it('draws the same rows in fullscreen as the normal transcript', () => {
		for (const width of [40, 80, 120]) {
			const fullscreen = markdownRows(REPLY, width, '#fff').map((r) => r.text.replace(/ +$/u, ''))
			expect(fullscreen).toEqual(draw(REPLY, width))
		}
	})

	it('carries the bar on every fullscreen row of a quote, and skips it when rows are joined', () => {
		const rows = markdownRows('> aaaa bbbb cccc dddd', 12, '#fff')
		expect(rows.map((r) => r.text)).toEqual(['│ aaaa bbbb', '│ cccc dddd'])
		expect(rows[1]?.joins).toBe(' ')
		expect(rows[1]?.lead).toBe(2)
	})
})

describe('how each level is told apart', () => {
	it('gives each level its own look', () => {
		expect(headingStyle(1)).toEqual({ color: 'accent', underline: true })
		expect(headingStyle(2)).toEqual({ color: 'accent', underline: false })
		expect(headingStyle(3)).toEqual({ color: 'body', underline: false })
		for (const level of [4, 5, 6])
			expect(headingStyle(level)).toEqual({ color: 'muted', underline: false })
	})

	it('measures a rule in cells, capped at 40', () => {
		expect(ruleWidth(120)).toBe(40)
		expect(ruleWidth(12)).toBe(12)
	})

	it('draws the levels with different attributes, inline styles kept', () => {
		const style = (level: number) => {
			const row = markdownRows(`${'#'.repeat(level)} A \`c\` [l](http://x.y)`, 80, '#body')[0]
			return row?.spans.find((span) => span.text === 'A ')
		}
		const accent = style(1)?.color
		expect(style(1)).toMatchObject({ bold: true, underline: true })
		expect(style(2)).toMatchObject({ bold: true, color: accent })
		expect(style(2)?.underline).toBeUndefined()
		expect(style(3)).toMatchObject({ bold: true, color: '#body' })
		expect(accent).not.toBe('#body')
		const muted = style(4)?.color
		expect(muted).not.toBe('#body')
		expect(muted).not.toBe(accent)
		expect(style(5)).toEqual(style(4))
		expect(style(6)).toEqual(style(4))
		const row = markdownRows('# A `c`', 80, '#body')[0]
		expect(row?.spans.find((span) => span.text === 'c')).toMatchObject({
			bold: true,
			underline: true,
		})
	})

	it('draws quote text in italics and the bar in the border colour', () => {
		const row = markdownRows('> a **b**', 80, '#body')[0]
		expect(row?.spans[0]?.text).toBe('│')
		expect(row?.spans.slice(2).every((span) => span.italic === true)).toBe(true)
		expect(row?.spans.slice(2)[0]?.color).toBe('#body')
	})
})
