import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageContent } from './message.js'

describe('message presentation', () => {
	it('renders assistant structure without making model content executable or fetching media', () => {
		const html = renderToStaticMarkup(
			createElement(MessageContent, {
				markdown: true,
				text: '# Result\n\n- **Done**\n\n```sh\necho ready\n```\n\n<script>alert(1)</script>\n\n![private](https://example.test/track)\n\n[link](javascript:alert(1))',
			}),
		)
		expect(html).toContain('<h1>Result</h1>')
		expect(html).toContain('<strong>Done</strong>')
		expect(html).toContain('<pre><code')
		expect(html).not.toContain('<script')
		expect(html).not.toContain('<img')
		expect(html).not.toContain('src=')
		expect(html).not.toContain('href=')
	})
	it('keeps user-authored Markdown and HTML literal', () => {
		const html = renderToStaticMarkup(
			createElement(MessageContent, { text: '**exact text** <button>Run</button>' }),
		)
		expect(html).toContain('**exact text** &lt;button&gt;Run&lt;/button&gt;')
		expect(html).not.toContain('<button')
	})
})
