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
