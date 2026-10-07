import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { expect, it } from 'vitest'
import { COPY_CODE_PROPERTY, markdownCodeCopy, remarkCodeCopy } from './markdown-code-copy.js'
import { MessageContent } from './message.js'

function parsedCode(source: string) {
	const blocks: { text: string; language: string }[] = []
	renderToStaticMarkup(
		createElement(
			Markdown,
			{
				remarkPlugins: [[remarkCodeCopy, { source }]],
				components: {
					pre: ({ node, children }) => {
						const code = markdownCodeCopy(node)
						if (code) blocks.push(code)
						return createElement('pre', null, children)
					},
					code: ({ children }) => createElement('code', null, children),
				},
			},
			source,
		),
	)
	return blocks
}

it('uses the real parser value, preserving Unicode, indentation and internal CRLF', () => {
	expect(parsedCode('```ts\r\n  Türkçe 🐇\r\n\r\n  tail\r\n```')).toEqual([
		{ language: 'ts', text: '  Türkçe 🐇\r\n\r\n  tail' },
	])
})

it('does not invent an LF for unclosed code and does not trim intentional blank lines', () => {
	expect(parsedCode('```sh\nprintf hello')).toEqual([{ language: 'sh', text: 'printf hello' }])
	expect(parsedCode('```text\nalpha\n\n```')).toEqual([{ language: 'text', text: 'alpha\n' }])
	expect(parsedCode('```text\nalpha\n\n\n```')).toEqual([{ language: 'text', text: 'alpha\n\n' }])
})

it('uses established Markdown container semantics for quoted and indented code', () => {
	expect(parsedCode('> ```js\n>  hello\n> ```')).toEqual([{ language: 'js', text: ' hello' }])
	expect(parsedCode('    alpha\n    beta\n')).toEqual([{ language: '', text: 'alpha\nbeta' }])
	expect(parsedCode('`inline`')).toEqual([])
})

it('keeps internal copy payload out of DOM attributes and exposes keyboard table regions', () => {
	const html = renderToStaticMarkup(
		createElement(MessageContent, {
			markdown: true,
			text: '```sh\nprintf hello\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |',
		}),
	)
	expect(html).toContain('aria-label="Copy code"')
	expect(html).toContain('chat-markdown-codeblock-language')
	expect(html).not.toContain(COPY_CODE_PROPERTY)
	expect(html).toContain('<section class="table-scroll" aria-label="Table" tabindex="0"')
	expect(html.match(/printf hello/g)).toHaveLength(1)
})
