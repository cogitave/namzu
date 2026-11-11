import { describe, expect, it } from 'vitest'

import { parseInline, parseMarkdown } from './markdownParser.js'

describe('parseMarkdown', () => {
	it('parses a fenced code block with a language', () => {
		const blocks = parseMarkdown('before\n```ts\nconst x = 1\nconst y = 2\n```\nafter')
		expect(blocks).toEqual([
			{ type: 'paragraph', text: 'before' },
			{ type: 'code', lang: 'ts', lines: ['const x = 1', 'const y = 2'] },
			{ type: 'paragraph', text: 'after' },
		])
	})

	it('parses headings at varying levels', () => {
		expect(parseMarkdown('# Title')).toEqual([{ type: 'heading', level: 1, text: 'Title' }])
		expect(parseMarkdown('### Sub')).toEqual([{ type: 'heading', level: 3, text: 'Sub' }])
	})

	it('parses unordered and ordered list items', () => {
		const blocks = parseMarkdown('- one\n- two\n1. first\n2) second')
		expect(blocks).toEqual([
			{ type: 'bullet', ordered: false, marker: '•', text: 'one' },
			{ type: 'bullet', ordered: false, marker: '•', text: 'two' },
			{ type: 'bullet', ordered: true, marker: '1', text: 'first' },
			{ type: 'bullet', ordered: true, marker: '2', text: 'second' },
		])
	})

	it('merges consecutive plain lines into one paragraph and splits on blanks', () => {
		const blocks = parseMarkdown('line one\nline two\n\nsecond para')
		expect(blocks).toEqual([
			{ type: 'paragraph', text: 'line one line two' },
			{ type: 'paragraph', text: 'second para' },
		])
	})

	it('keeps code content verbatim (no markdown interpretation inside)', () => {
		const blocks = parseMarkdown('```\n# not a heading\n- not a bullet\n```')
		expect(blocks).toEqual([
			{ type: 'code', lang: undefined, lines: ['# not a heading', '- not a bullet'] },
		])
	})
})

describe('headings, quotes and rules', () => {
	it('parses a heading of each of the six levels', () => {
		for (let level = 1; level <= 6; level++) {
			expect(parseMarkdown(`${'#'.repeat(level)} T`)).toEqual([
				{ type: 'heading', level, text: 'T' },
			])
		}
	})

	it('reads a quote as the blocks inside it, with the marks taken off', () => {
		expect(parseMarkdown('> one\n> two')).toEqual([
			{ type: 'quote', blocks: [{ type: 'paragraph', text: 'one two' }] },
		])
		expect(parseMarkdown('> a long quoted paragraph that wraps\n>\n> second')).toEqual([
			{
				type: 'quote',
				blocks: [
					{ type: 'paragraph', text: 'a long quoted paragraph that wraps' },
					{ type: 'paragraph', text: 'second' },
				],
			},
		])
	})

	it('reads a quote inside a quote', () => {
		expect(parseMarkdown('> outer\n>\n> > inner')).toEqual([
			{
				type: 'quote',
				blocks: [
					{ type: 'paragraph', text: 'outer' },
					{ type: 'quote', blocks: [{ type: 'paragraph', text: 'inner' }] },
				],
			},
		])
	})

	it('reads a list inside a quote', () => {
		expect(parseMarkdown('> - a\n> - b')).toEqual([
			{
				type: 'quote',
				blocks: [
					{ type: 'bullet', ordered: false, marker: '•', text: 'a' },
					{ type: 'bullet', ordered: false, marker: '•', text: 'b' },
				],
			},
		])
	})

	it('reads a line that is only ">" as an empty line inside the quote', () => {
		expect(parseMarkdown('>')).toEqual([{ type: 'quote', blocks: [] }])
		expect(parseMarkdown('> a\n>\n> b')).toEqual([
			{
				type: 'quote',
				blocks: [
					{ type: 'paragraph', text: 'a' },
					{ type: 'paragraph', text: 'b' },
				],
			},
		])
	})

	it('takes a ">" that is not at the start of a line as text', () => {
		expect(parseMarkdown('a > b')).toEqual([{ type: 'paragraph', text: 'a > b' }])
		expect(parseMarkdown('x -> y\n1 > 0')).toEqual([{ type: 'paragraph', text: 'x -> y 1 > 0' }])
	})

	it('allows spaces before the ">" and ends the quote at a line without one', () => {
		expect(parseMarkdown('  > a\nplain')).toEqual([
			{ type: 'quote', blocks: [{ type: 'paragraph', text: 'a' }] },
			{ type: 'paragraph', text: 'plain' },
		])
	})

	it('lets a quote interrupt a paragraph', () => {
		expect(parseMarkdown('before\n> quoted')).toEqual([
			{ type: 'paragraph', text: 'before' },
			{ type: 'quote', blocks: [{ type: 'paragraph', text: 'quoted' }] },
		])
	})

	it('reads each spelling of a rule', () => {
		for (const line of [
			'---',
			'***',
			'___',
			'- - -',
			'* * *',
			'_ _ _',
			'-----',
			'  ---',
			'---  ',
		]) {
			expect(parseMarkdown(line), line).toEqual([{ type: 'rule' }])
		}
	})

	it('keeps "--" and a mixed run as text, and "- -" as a list item', () => {
		expect(parseMarkdown('--')).toEqual([{ type: 'paragraph', text: '--' }])
		expect(parseMarkdown('**')).toEqual([{ type: 'paragraph', text: '**' }])
		expect(parseMarkdown('-*-')).toEqual([{ type: 'paragraph', text: '-*-' }])
		expect(parseMarkdown('--- x')).toEqual([{ type: 'paragraph', text: '--- x' }])
		expect(parseMarkdown('- -')).toEqual([
			{ type: 'bullet', ordered: false, marker: '•', text: '-' },
		])
	})

	it('does not read a rule or a quote inside a code fence', () => {
		expect(parseMarkdown('```\n---\n> not a quote\n- - -\n```')).toEqual([
			{ type: 'code', lang: undefined, lines: ['---', '> not a quote', '- - -'] },
		])
	})

	it('reads a quoted fence as code inside the quote', () => {
		expect(parseMarkdown('> ```\n> ---\n> ```')).toEqual([
			{ type: 'quote', blocks: [{ type: 'code', lang: undefined, lines: ['---'] }] },
		])
	})

	it('reads "Title" over "---" as a paragraph and a rule, never an underlined heading', () => {
		expect(parseMarkdown('Title\n---')).toEqual([
			{ type: 'paragraph', text: 'Title' },
			{ type: 'rule' },
		])
		expect(parseMarkdown('Title\n===')).toEqual([{ type: 'paragraph', text: 'Title ===' }])
	})

	it('settles a growing rule and a growing quote once', () => {
		const kinds = (src: string) => parseMarkdown(src).map((b) => b.type)
		const rule = ['-', '--', '---', '----'].map(kinds)
		expect(rule).toEqual([['paragraph'], ['paragraph'], ['rule'], ['rule']])
		const spaced = ['-', '- -', '- - -', '- - - -'].map(kinds)
		expect(spaced).toEqual([['paragraph'], ['bullet'], ['rule'], ['rule']])
		const quote = ['>', '> a', '> a b'].map(kinds)
		expect(quote).toEqual([['quote'], ['quote'], ['quote']])
	})

	it('leaves a table, a list and a table next to a quote as they were', () => {
		expect(parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n> q | r')).toMatchObject([
			{ type: 'table' },
			{ type: 'quote' },
		])
	})
})

describe('parseInline', () => {
	it('splits bold, italic, and inline code', () => {
		expect(parseInline('a **b** c `d` e *f*')).toEqual([
			{ text: 'a ' },
			{ text: 'b', bold: true },
			{ text: ' c ' },
			{ text: 'd', code: true },
			{ text: ' e ' },
			{ text: 'f', italic: true },
		])
	})

	it('treats __x__ as bold and _x_ as italic', () => {
		expect(parseInline('__b__ and _i_')).toEqual([
			{ text: 'b', bold: true },
			{ text: ' and ' },
			{ text: 'i', italic: true },
		])
	})

	it('returns a single span for plain text', () => {
		expect(parseInline('just text')).toEqual([{ text: 'just text' }])
	})

	it.each(['RUN_LIMITS_READY', 'some__field__name', 'işlem_çok_uzun', '变量_名称_值', 'v1_2_3'])(
		'preserves literal underscores in %s',
		(text) => {
			expect(parseInline(text)).toEqual([{ text }])
		},
	)

	it('styles surrounding prose without changing identifiers', () => {
		expect(parseInline('RUN_LIMITS_READY (_done_) __ok__')).toEqual([
			{ text: 'RUN_LIMITS_READY (' },
			{ text: 'done', italic: true },
			{ text: ') ' },
			{ text: 'ok', bold: true },
		])
	})

	it('does not parse markers inside inline code', () => {
		expect(parseInline('`a*b*c`')).toEqual([{ text: 'a*b*c', code: true }])
	})

	it('parses a [text](url) link', () => {
		expect(parseInline('see [the docs](https://x.dev/a) now')).toEqual([
			{ text: 'see ' },
			{ text: 'the docs', link: 'https://x.dev/a' },
			{ text: ' now' },
		])
	})
})

describe('parseMarkdown tables', () => {
	it('parses a pipe table with header + separator + rows', () => {
		const blocks = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
		expect(blocks).toEqual([
			{
				type: 'table',
				headers: ['A', 'B'],
				rows: [
					['1', '2'],
					['3', '4'],
				],
			},
		])
	})

	it('does not treat a lone pipe line without a separator as a table', () => {
		const blocks = parseMarkdown('| not | a table |\njust text')
		expect(blocks[0]?.type).toBe('paragraph')
	})

	it('keeps a row without a closing pipe — or one still being typed — inside its table', () => {
		const blocks = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | fo')
		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toEqual({
			type: 'table',
			headers: ['A', 'B'],
			rows: [
				['1', '2'],
				['3', 'fo'],
			],
		})
		// A blank line still ends it.
		expect(parseMarkdown('| A |\n|---|\n| 1 |\n\nafter').map((b) => b.type)).toEqual([
			'table',
			'paragraph',
		])
	})

	it('ends a table at a list item or blockquote that carries a pipe', () => {
		const table = '| A | B |\n|---|---|\n| 1 | 2 |\n'
		const afterBullet = parseMarkdown(`${table}- bullet | with pipe`)
		expect(afterBullet.map((b) => b.type)).toEqual(['table', 'bullet'])
		expect(afterBullet[0]).toMatchObject({ rows: [['1', '2']] })
		expect(afterBullet[1]).toMatchObject({ text: 'bullet | with pipe' })
		expect(parseMarkdown(`${table}1. step | two`).map((b) => b.type)).toEqual(['table', 'bullet'])
		const afterQuote = parseMarkdown(`${table}> a | b`)
		expect(afterQuote).toHaveLength(2)
		expect(afterQuote[0]).toMatchObject({ rows: [['1', '2']] })
		expect(afterQuote[1]?.type).not.toBe('table')
	})

	it('reads an escaped pipe as a character of its cell', () => {
		const [block] = parseMarkdown('| op | meaning |\n|---|---|\n| `a \\| b` | either |')
		expect(block).toMatchObject({ rows: [['`a | b`', 'either']] })
	})

	it('records the separator row’s alignment only when a column asks for one', () => {
		expect(parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')[0]).toMatchObject({
			align: ['left', 'center', 'right'],
		})
		expect(parseMarkdown('| a |\n|---|\n| 1 |')[0]).not.toHaveProperty('align')
	})
})

describe('parseInline nesting', () => {
	it('parses the spans inside emphasis, so bold code is code that is bold', () => {
		expect(parseInline('**`@openclaw/runtime`** and *a [link](https://x.dev)*')).toEqual([
			{ text: '@openclaw/runtime', code: true, bold: true },
			{ text: ' and ' },
			{ text: 'a ', italic: true },
			{ text: 'link', link: 'https://x.dev', italic: true },
		])
	})
})
