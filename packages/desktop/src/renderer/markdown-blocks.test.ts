import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { markdownBlockSources, splitMarkdownBlocks } from './markdown-blocks.js'
import { MarkdownBody } from './message.js'

const blocksOf = (text: string) => splitMarkdownBlocks(text)

/** Block elements are separated by a newline text node in one parse and by nothing across two. */
function html(text: string, split: boolean): string {
	return renderToStaticMarkup(createElement(MarkdownBody, { text, split }))
		.replace(/>\n+</g, '><')
		.replace(/ id="base-ui-[^"]*"/g, '')
}

describe('splitMarkdownBlocks', () => {
	it('keeps every character: the pieces concatenate to the input', () => {
		for (const text of ['', 'a', 'a\n', 'a\n\nb', '\n\na\n\n\nb\n\n', 'a\r\n\r\nb\r\n', '  \n\na'])
			expect(blocksOf(text).join('')).toBe(text)
	})

	it('cuts after the blank lines that end a block', () => {
		expect(blocksOf('one\n\ntwo\n\n\nthree')).toEqual(['one\n\n', 'two\n\n\n', 'three'])
	})

	it('treats whitespace-only lines as blank and keeps leading blank lines with the first block', () => {
		expect(blocksOf('\n\none\n \t\ntwo')).toEqual(['\n\none\n \t\n', 'two'])
	})

	it('never cuts inside a fenced code block, however many blank lines it holds', () => {
		const text = 'intro\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nafter'
		expect(blocksOf(text)).toEqual([
			'intro\n\n',
			'```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n',
			'after',
		])
	})

	it('keeps an unterminated fence, the usual state of a stream, as the open tail', () => {
		const text = 'intro\n\n```ts\nconst a = 1\n\nconst b'
		expect(blocksOf(text)).toEqual(['intro\n\n', '```ts\nconst a = 1\n\nconst b'])
	})

	it('closes a fence only on a marker of the same kind and at least the same length', () => {
		const text = '````md\n```\n\nstill code\n~~~\n\n````\n\nafter'
		expect(blocksOf(text)).toEqual(['````md\n```\n\nstill code\n~~~\n\n````\n\n', 'after'])
		expect(blocksOf('~~~\ncode\n\n```\n\nmore\n~~~\n\nafter')).toHaveLength(2)
	})

	it('does not read a backtick span that opens a line as a fence', () => {
		expect(blocksOf('``` not a fence ` here\n\nnext')).toHaveLength(2)
	})

	it('tracks an indented fence inside a list item', () => {
		const text = '- item\n\n  ```\n  a\n\n  b\n  ```\n\nafter'
		expect(blocksOf(text).join('')).toBe(text)
		expect(blocksOf(text).at(-1)).toBe('after')
	})

	it('keeps a table whole and cuts after it', () => {
		const text = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter'
		expect(blocksOf(text)).toEqual(['| a | b |\n| - | - |\n| 1 | 2 |\n\n', 'after'])
	})

	it('keeps a loose list in one block, because its items are one list', () => {
		const text = '1. one\n\n2. two\n\n3. three\n\nafter'
		expect(blocksOf(text)).toEqual(['1. one\n\n2. two\n\n3. three\n\n', 'after'])
		expect(blocksOf('- a\n\n  continued\n\n- b')).toHaveLength(1)
	})

	it('keeps a list that follows a paragraph line with the later items of that list', () => {
		expect(blocksOf('intro\n- a\n\n- b')).toHaveLength(1)
	})

	it('cuts between a list and a following paragraph, and between a paragraph and a list', () => {
		expect(blocksOf('- a\n- b\n\nparagraph\n\n- c')).toEqual([
			'- a\n- b\n\n',
			'paragraph\n\n',
			'- c',
		])
	})

	it('does not cut after indented code, which a fresh parse would read differently', () => {
		expect(blocksOf('para\n\n    one\n\n    two\n\nafter')).toHaveLength(1)
		expect(blocksOf('intro\n\n\n    one\n\n    two\n\n')).toHaveLength(1)
		expect(blocksOf('    one\n\n    two\n\n- after')).toHaveLength(1)
	})

	it('leaves a text whole when a fence-like line cannot be classified', () => {
		expect(blocksOf('a\n\n    ~~~\nb\n\n~~~\n\nc')).toEqual(['a\n\n    ~~~\nb\n\n~~~\n\nc'])
		expect(blocksOf('text\n    ```\nb\n\nc')).toEqual(['text\n    ```\nb\n\nc'])
	})

	it('handles CRLF line endings', () => {
		const text = 'one\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\ntwo'
		expect(blocksOf(text)).toEqual(['one\r\n\r\n', '```\r\na\r\n\r\nb\r\n```\r\n\r\n', 'two'])
	})

	it('does not split a text that uses a bare CR as its line ending', () => {
		expect(blocksOf('one\r\rtwo')).toEqual(['one\r\rtwo'])
	})

	it('does not split a text with a link or footnote definition anywhere', () => {
		expect(blocksOf('see [a][1]\n\nmore\n\n[1]: https://example.test')).toHaveLength(1)
		expect(blocksOf('text[^n]\n\nmore\n\n[^n]: the note')).toHaveLength(1)
		expect(blocksOf('- [x]: item\n\nmore')).toHaveLength(1)
	})

	it('does not split a text with an HTML block, which can swallow what looks like a fence', () => {
		expect(blocksOf('a\n\n<!--\n\nhidden\n\n-->\n\nb')).toHaveLength(1)
		expect(blocksOf('a\n\n<pre>\n\nx\n\n</pre>\n\nb')).toHaveLength(1)
		expect(blocksOf('a\n\n</div>- x\n~~~\ny\n\n~~~\n\nb')).toHaveLength(1)
	})

	it('still splits a text whose lines start with an autolink or a comparison', () => {
		expect(
			blocksOf('<https://example.test> is a link\n\n<me@example.test> too\n\n< 3 apples'),
		).toHaveLength(3)
	})

	it('splits a task list, which is not a definition', () => {
		expect(blocksOf('- [ ] todo\n- [x] done\n\nafter')).toHaveLength(2)
	})
})

describe('markdownBlockSources', () => {
	it('drops the blank lines that end a block, so the tail is unchanged when they arrive', () => {
		expect(markdownBlockSources('one\n\ntwo')).toEqual(['one', 'two'])
		expect(markdownBlockSources('one\n\n\ntwo\n\n')).toEqual(['one', 'two'])
		expect(markdownBlockSources('a\r\n\r\nb\r\n')).toEqual(['a', 'b'])
	})

	it('keeps trailing spaces of the last line, which indented code and hard breaks use', () => {
		expect(markdownBlockSources('para\n\n- item  \n\nafter')).toEqual(['para', '- item  ', 'after'])
	})

	it('keeps the end of a piece that stops inside an open fence, where blank lines are code', () => {
		expect(markdownBlockSources('one\n\n```\ncode\n\n')).toEqual(['one', '```\ncode\n\n'])
		expect(markdownBlockSources('```\ncode\n```\n\n')).toEqual(['```\ncode\n```'])
	})

	it('leaves a text that was not split exactly as it came', () => {
		const text = 'see [a][1]\n\n[1]: https://example.test\n\n'
		expect(markdownBlockSources(text)).toEqual([text])
	})
})

describe('rendering the blocks equals rendering the whole text', () => {
	const cases: Record<string, string> = {
		paragraphs: 'One *two* **three**.\n\nSecond [link](https://example.test) and `code`.\n\nThird.',
		'loose list': '1. one\n\n2. two\n\n3. three\n\ntext\n\n4. four',
		'tight then loose': '- a\n- b\n\n- c\n\nafter',
		'nested list': '- a\n  - b\n\n    para in b\n\n- c',
		fence: 'intro\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nafter',
		'unterminated fence': 'intro\n\n```ts\nconst a = 1\n\nstill code',
		table: '| a | b |\n| - | - |\n| 1 | 2 |\n\n| c |\n| - |\n| 3 |',
		quote: '> one\n>\n> two\n\n> three',
		'indented code': 'para\n\n    one\n\n    two\n\nafter',
		'reference link': 'See [the docs][docs].\n\nMore.\n\n[docs]: https://example.test',
		footnote: 'Note[^1].\n\nMore.\n\n[^1]: The note.',
		'html comment': 'a\n\n<!--\n\nhidden\n\n-->\n\nb',
		html: 'a\n\n<div>\n\ninside\n\n</div>\n\nb',
		crlf: 'one\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\ntwo\r\n\r\n- x\r\n\r\n- y',
		headings: '# One\n\ntext\n\n## Two\n\n---\n\nSetext\n---\n\nend',
		'trailing blank lines': 'one\n\n\n\n',
		'leading blank lines': '\n\n\none\n\ntwo',
	}
	for (const [name, text] of Object.entries(cases))
		it(name, () => {
			expect(html(text, true)).toBe(html(text, false))
		})

	// A fixed-seed generator: the same inputs on every run, no clock involved.
	function random(seed: number) {
		let state = seed >>> 0
		return () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0
			return state / 2 ** 32
		}
	}
	const pieces = [
		'A plain paragraph with *emphasis* and a [link](https://example.test).',
		'# Heading',
		'Setext\n---',
		'- item one\n- item two',
		'- loose one\n\n- loose two',
		'1. first\n\n2. second',
		'- parent\n  - child\n\n    child paragraph',
		'```ts\nlet a = 1\n\nlet b = 2\n```',
		'~~~\nfence with ``` inside\n\n~~~',
		'```\nnever closed\n\nstill code',
		'| a | b |\n| - | - |\n| 1 | 2 |',
		'> quoted\n>\n> more quoted',
		'    indented code\n\n    more',
		'---',
		'Term with `inline code` and **bold**',
		'[ref]: https://example.test/ref',
		'Uses [ref] and [other][ref].',
		'<!-- a comment\n\nover a gap -->',
		'<div>\n\nbody\n\n</div>',
		'- [ ] task\n- [x] done',
		'text[^1]\n\n[^1]: note',
		'    ',
		'* * *',
		'3. starts at three\n4. four',
		'- a\n\n  ```\n  x\n\n  y\n  ```\n\n- b',
		'> - quoted item\n>\n> - second',
		'a | b\n- | -\n1 | 2',
		'line one  \nline two',
		'[inline](https://e.test "t") **bold\n\nspan** `code\n\nspan`',
		'<https://e.test> and <me@e.test>',
		'1) paren\n\n2) list',
		'+ plus\n\n+ plus',
		'Hello\n===',
		'    ~~~\nfence with ``` inside\n\n~~~',
		'',
	]
	// The 800 documents of one fixed-seed sequence, generated in order and then dealt out in
	// consecutive chunks, so the chunks together are exactly that sequence. Every document is both
	// split-checked and render-compared; the chunks keep each test far below the time limit of a
	// loaded CI runner, where rendering (about 1.7 ms a pass, twice per document) is the cost.
	const DOCUMENTS = 800
	const CHUNKS = 8
	const documents: string[] = []
	{
		const next = random(20261007)
		for (let round = 0; round < DOCUMENTS; round++) {
			const count = 1 + Math.floor(next() * 7)
			let text = ''
			for (let index = 0; index < count; index++) {
				text += pieces[Math.floor(next() * pieces.length)] ?? ''
				text += ['\n\n', '\n', '\n\n\n', ' \n\n', ''][Math.floor(next() * 5)] ?? ''
			}
			if (next() < 0.25) text = text.replace(/\n/g, '\r\n')
			// A stream stops anywhere; every prefix of a document is a state the reader can see.
			documents.push(next() < 0.5 ? text : text.slice(0, Math.floor(next() * text.length)))
		}
	}
	const size = DOCUMENTS / CHUNKS
	for (let chunk = 0; chunk < CHUNKS; chunk++)
		it(`holds for generated documents ${chunk * size} to ${(chunk + 1) * size - 1}, and the pieces always concatenate to the input`, () => {
			for (const cut of documents.slice(chunk * size, (chunk + 1) * size)) {
				expect(splitMarkdownBlocks(cut).join('')).toBe(cut)
				expect(html(cut, true), JSON.stringify(cut)).toBe(html(cut, false))
			}
		})
})
