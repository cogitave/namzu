import { Box, Text, renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'

// Colour on, so the two screens are compared with their styling and not only their text.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { ContentWidth, Markdown } from '../Markdown.js'
import { contentColorForRole } from '../Transcript.js'
import { messageScrollRows, scrollTextWidth, transcriptScrollRows } from '../transcript-scroll.js'
import type { TranscriptMessage } from '../types.js'
import { createLayoutCache, fullscreenMessageRows, layoutTranscript } from './layout.js'
import { markdownRows } from './markdown-rows.js'
import { paintRow } from './paint.js'
import type { FsRow } from './rows.js'

const REPLY = [
	'# A heading',
	'',
	'Some prose with `inline code`, **bold**, *italic* and a [link](https://example.com/a/very/long/address) that is long enough to wrap onto a second row on a narrow screen.',
	'',
	'## Steps',
	'',
	'- first item',
	'- second item that is long enough that it has to wrap and hang under its marker',
	'3. a numbered one',
	'',
	'```ts',
	'const short = 1',
	'const aVeryLongLineOfCodeThatDoesNotFitInTheRowsOfAnyNarrowTerminalAtAll = compute(argument, another)',
	'',
	'done()',
	'```',
	'',
	'| name | value |',
	'| --- | --: |',
	'| alpha | 1 |',
	'| beta | 22 |',
	'',
	'漢字とemoji 🎉 in a sentence that wraps across more than one row of the window for sure.',
].join('\n')

const WIDTH = 38

/** What the normal transcript draws for the reply: its own renderer, at the same width. */
function normal(text: string, width: number): string {
	return renderToString(
		<ContentWidth.Provider value={width}>
			<Box width={width}>
				<Markdown text={text} color={contentColorForRole('assistant')} />
			</Box>
		</ContentWidth.Provider>,
		{ columns: width },
	)
}

/** What the window draws: the rows, each in the same Ink the window uses. */
function windowed(rows: readonly FsRow[], width: number): string {
	return renderToString(
		<Box flexDirection="column" width={width}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
				<Box key={i} width={width} height={1}>
					<Text wrap="truncate-end">
						{row.text.length > 0
							? paintRow(row, []).map((span, j) => (
									<Text
										// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
										key={j}
										color={span.color}
										bold={span.bold}
										italic={span.italic}
										underline={span.underline}
									>
										{span.text}
									</Text>
								))
							: null}
					</Text>
				</Box>
			))}
		</Box>,
		{ columns: width },
	)
}

/**
 * A row's trailing blanks are not on the screen, whether Ink keeps one before a
 * colour reset or drops it: compare without them.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts a colour
const TRAILING_BLANKS = / +((?:\u001b\[[0-9;]*m)*)$/u
const same = (a: string): string =>
	a
		.split('\n')
		.map((line) => line.replace(TRAILING_BLANKS, '$1'))
		.join('\n')

const reply = (content: string): TranscriptMessage => ({ id: 'r', role: 'assistant', content })

describe('the window draws a reply as the normal transcript does', () => {
	for (const width of [38, 60, 100]) {
		it(`draws the same screen at ${width} columns, styling included`, () => {
			const rows = fullscreenMessageRows(reply(REPLY), false, width).rows
			expect(same(windowed(rows, width))).toBe(same(normal(REPLY, width)))
		})
	}

	const STRUCTURE = [
		'# One',
		'## Two',
		'### Three',
		'#### Four with `code` and **bold**',
		'',
		'> a quote long enough to wrap onto a second row, with *italics* and **bold**',
		'>',
		'> - an item',
		'> > nested',
		'',
		'---',
		'',
		'after',
	].join('\n')

	for (const width of [38, 80]) {
		it(`draws headings, quotes and rules the same at ${width} columns, styling included`, () => {
			const rows = fullscreenMessageRows(reply(STRUCTURE), false, width).rows
			expect(same(windowed(rows, width))).toBe(same(normal(STRUCTURE, width)))
		})
	}

	it('is compared with its colours', () => {
		const rows = fullscreenMessageRows(reply('**bold** and `code`'), false, 40).rows
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte starts a colour
		expect(windowed(rows, 40)).toMatch(/\u001b\[/u)
	})

	it('keeps headings, bullets, code and tables recognisable as rows of plain text', () => {
		const text = markdownRows(REPLY, WIDTH, '#fff').map((row) => row.text)
		expect(text[0]).toBe('A heading')
		expect(text).toContain('• first item')
		expect(text).toContain('const short = 1')
		expect(text.some((row) => row.startsWith('┌'))).toBe(true)
		expect(text.every((row) => !row.includes('```') && !row.includes('# '))).toBe(true)
	})

	it('cuts a code line too long for the row the way the normal transcript does', () => {
		const long = 'x'.repeat(30)
		const rows = fullscreenMessageRows(reply(`\`\`\`\n${long}\n\`\`\``), false, 12).rows
		expect(rows.map((row) => row.text)).toEqual(['xxxxxxxxxxxx', 'xxxxxxxxxxxx', 'xxxxxx'])
		expect(rows.map((row) => row.joins)).toEqual([null, '', ''])
		expect(same(windowed(rows, 12))).toBe(same(normal(`\`\`\`\n${long}\n\`\`\``, 12)))
	})

	it('draws nothing that is not text beside the code', () => {
		const rows = markdownRows('```\nls -la\n```', 30, '#fff')
		expect(rows.map((row) => row.text)).toEqual(['ls -la'])
	})

	it('lays a reply out once per message and width', () => {
		const cache = createLayoutCache()
		const messages = [reply(REPLY)]
		const first = layoutTranscript(messages, null, undefined, 40, cache)
		const again = layoutTranscript(messages, null, undefined, 40, cache)
		expect(again.rows[0]).toBe(first.rows[0])
		expect(layoutTranscript(messages, null, undefined, 60, cache).rows).not.toBe(first.rows)
	})

	it('puts the glyph on the first row only', () => {
		const rows = fullscreenMessageRows(reply(REPLY), false, WIDTH).rows
		expect(rows[0]?.glyph).not.toBe(' ')
		expect(rows.slice(1).every((row) => row.glyph === ' ')).toBe(true)
	})

	it('leaves every other role as the plain rows, unrendered', () => {
		const user: TranscriptMessage = {
			id: 'u',
			role: 'user',
			content: '# not a heading\n- nor a list',
		}
		const rows = fullscreenMessageRows(user, false, WIDTH).rows
		expect(rows.map((row) => row.text)).toEqual(['# not a heading', '- nor a list'])
		expect(rows.every((row) => row.spans === undefined)).toBe(true)
	})
})

describe('the default screen is unchanged', () => {
	it('still shows a reply as written in the scroll view that is not fullscreen', () => {
		const rows = transcriptScrollRows([reply('# A heading\n\n- an item')], null, undefined, 40)
		expect(rows.map((row) => row.text)).toEqual(['# A heading', '', '- an item'])
		const own = messageScrollRows(reply('# A heading'), false, scrollTextWidth(40))
		expect(own.rows.map((row) => row.text)).toEqual(['# A heading'])
		expect('spans' in (own.rows[0] ?? {})).toBe(false)
	})
})
