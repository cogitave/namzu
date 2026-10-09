import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageContent, MessageTime } from './message.js'

const parsed = vi.hoisted(() => vi.fn<(text: string) => void>())
vi.mock('react-markdown', async (original) => {
	const actual = await original<typeof import('react-markdown')>()
	return {
		...actual,
		default: (props: Parameters<typeof actual.default>[0]) => {
			parsed(props.children ?? '')
			return createElement(actual.default, props)
		},
	}
})
beforeEach(() => parsed.mockClear())
afterEach(() => vi.unstubAllGlobals())

// Only React's DOM mutations are needed for this reconciliation test: no layout,
// browser timing, events or HTML parser. Markdown still uses its real processor.
class MemoryNode {
	namespaceURI = 'http://www.w3.org/1999/xhtml'
	parentNode: MemoryNode | null = null
	childNodes: MemoryNode[] = []
	attributes = new Map<string, string>()
	style = {}
	nodeValue = ''
	nodeName: string
	tagName: string
	constructor(
		readonly tag: string,
		readonly ownerDocument: unknown,
		readonly nodeType = 1,
	) {
		this.tagName = this.nodeName = tag.toUpperCase()
	}
	get firstChild() {
		return this.childNodes[0] ?? null
	}
	get nextSibling() {
		const siblings = this.parentNode?.childNodes ?? []
		return siblings[siblings.indexOf(this) + 1] ?? null
	}
	get textContent(): string {
		return this.childNodes.length
			? this.childNodes.map((child) => child.textContent).join('')
			: this.nodeValue
	}
	set textContent(value: string) {
		for (const child of this.childNodes) child.parentNode = null
		this.childNodes = []
		this.nodeValue = value
	}
	appendChild(child: MemoryNode) {
		child.parentNode?.removeChild(child)
		this.childNodes.push(child)
		child.parentNode = this
		return child
	}
	insertBefore(child: MemoryNode, before: MemoryNode) {
		child.parentNode?.removeChild(child)
		this.childNodes.splice(this.childNodes.indexOf(before), 0, child)
		child.parentNode = this
		return child
	}
	removeChild(child: MemoryNode) {
		this.childNodes.splice(this.childNodes.indexOf(child), 1)
		child.parentNode = null
		return child
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value)
	}
	removeAttribute(name: string) {
		this.attributes.delete(name)
	}
	addEventListener() {}
	removeEventListener() {}
}
function mountedMessage() {
	const document = {
		nodeType: 9,
		activeElement: null,
		defaultView: { HTMLIFrameElement: class {} },
		addEventListener() {},
		createElement: (tag: string): MemoryNode => new MemoryNode(tag, document),
		createTextNode: (text: string) => {
			const node = new MemoryNode('#text', document, 3)
			node.nodeValue = text
			return node
		},
	}
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.stubGlobal('window', document.defaultView)
	vi.stubGlobal('document', document)
	const container = document.createElement('div')
	const root = createRoot(container as unknown as HTMLElement)
	return {
		container,
		render: (content: ReturnType<typeof createElement>) =>
			act(() => flushSync(() => root.render(content))),
		unmount: () => act(() => flushSync(() => root.unmount())),
	}
}

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
	it('offers only credential-free HTTP(S) sources through the owned external bridge', () => {
		vi.stubGlobal('window', { namzu: { openExternal: vi.fn() } })
		const html = renderToStaticMarkup(
			createElement(MessageContent, {
				markdown: true,
				text: '[Source](https://example.test/report) [Unsafe](javascript:alert(1)) [Credentials](https://user:secret@example.test/)',
			}),
		)
		expect(html).toContain('href="https://example.test/report"')
		expect(html).not.toContain('href="javascript:')
		expect(html).not.toContain('href="https://user:secret@')
		expect(html.match(/<a\b/g)).toHaveLength(1)
	})
	it('links only a sole safe inline-code URL, preserving code blocks and command text', () => {
		vi.stubGlobal('window', { namzu: { openExternal: vi.fn() } })
		const html = renderToStaticMarkup(
			createElement(MessageContent, {
				markdown: true,
				text: [
					'`https://example.test/report`',
					'`https://user:secret@example.test/private`',
					'`file:///tmp/report`',
					'`curl https://example.test/command`',
					'`https://bad host/report`',
					'',
					'```text',
					'https://example.test/code-block',
					'```',
					'',
					'    https://example.test/indented-block',
				].join('\n'),
			}),
		)
		expect(html).toMatch(
			/<code><a [^>]*href="https:\/\/example\.test\/report"[^>]*class="message-link"/,
		)
		expect(html.match(/<a\b/g)).toHaveLength(1)
		expect(html).toContain('<pre><code')
		expect(html).toContain('https://example.test/code-block')
		expect(html).toContain('https://example.test/indented-block')
		expect(html).not.toContain('href="https://example.test/code-block"')
		expect(html).not.toContain('href="https://example.test/indented-block"')
	})
	it('keeps inline-code URLs inert without an external-opening bridge', () => {
		vi.stubGlobal('window', { namzu: {} })
		const html = renderToStaticMarkup(
			createElement(MessageContent, { markdown: true, text: '`https://example.test/report`' }),
		)
		expect(html).toContain('<code><span class="message-link"')
		expect(html).not.toContain('<a ')
	})
	it('labels only known timestamps with an exact machine-readable instant', () => {
		const saved = renderToStaticMarkup(
			createElement(MessageTime, { time: { at: 1_700_000_000_000, source: 'journal' } }),
		)
		expect(saved).toContain('dateTime="2023-11-14T22:13:20.000Z"')
		expect(saved).toContain('Received at ')
		expect(saved).not.toMatch(/Seen by Namzu|Saved in/)
		const sent = renderToStaticMarkup(
			createElement(MessageTime, {
				time: { at: 1_700_000_000_000, source: 'host' },
				direction: 'sent',
			}),
		)
		expect(sent).toContain('Sent at ')
		expect(sent).not.toContain('Received at')
		const focusable = renderToStaticMarkup(
			createElement(MessageTime, {
				time: { at: 1_700_000_000_000, source: 'journal' },
				focusable: true,
			}),
		)
		expect(focusable).toContain('<button')
		expect(focusable).toContain('aria-pressed="false"')
		expect(focusable).toContain('<time dateTime="2023-11-14T22:13:20.000Z"')
		expect(renderToStaticMarkup(createElement(MessageTime, {}))).toBe('')
		expect(
			renderToStaticMarkup(
				createElement(MessageTime, { time: { at: Number.NaN, source: 'host' } }),
			),
		).toBe('')
	})
	it('keeps user-authored Markdown and HTML literal', () => {
		const html = renderToStaticMarkup(
			createElement(MessageContent, { text: '**exact text** <button>Run</button>' }),
		)
		expect(html).toContain('**exact text** &lt;button&gt;Run&lt;/button&gt;')
		expect(html).not.toContain('<button')
	})
})

describe('settled Markdown reconciliation', () => {
	it('parses only the streaming body while settled message text is unchanged', () => {
		vi.useFakeTimers()
		const mounted = mountedMessage()
		const body = (live: string) =>
			createElement(
				'section',
				{},
				createElement(MessageContent, { key: 'first', markdown: true, text: '**First** result' }),
				createElement(MessageContent, { key: 'second', markdown: true, text: '**Second** result' }),
				createElement(MessageContent, { key: 'live', markdown: true, text: live }),
			)
		const later = (ms: number) => act(() => vi.advanceTimersByTime(ms))
		try {
			mounted.render(body('Streaming'))
			mounted.render(body('Streaming the'))
			// A change inside the 50 ms interval is held, so nothing is parsed for it yet.
			expect(parsed.mock.calls.map(([text]) => text)).toEqual([
				'**First** result',
				'**Second** result',
				'Streaming',
			])
			later(50)
			mounted.render(body('Streaming the answer'))
			later(50)
			expect(parsed.mock.calls.map(([text]) => text)).toEqual([
				'**First** result',
				'**Second** result',
				'Streaming',
				'Streaming the',
				'Streaming the answer',
			])
			expect(mounted.container.textContent).toBe('First resultSecond resultStreaming the answer')
		} finally {
			mounted.unmount()
			vi.useRealTimers()
		}
	})
	it('parses a burst of deltas once, for the newest text', () => {
		vi.useFakeTimers()
		const mounted = mountedMessage()
		const live = (text: string) => createElement(MessageContent, { markdown: true, text })
		try {
			mounted.render(live('a'))
			for (const text of ['ab', 'abc', 'abcd']) mounted.render(live(text))
			act(() => vi.advanceTimersByTime(50))
			expect(parsed.mock.calls.map(([text]) => text)).toEqual(['a', 'abcd'])
		} finally {
			mounted.unmount()
			vi.useRealTimers()
		}
	})
	it('shows the final text of a reply at once when it settles', () => {
		vi.useFakeTimers()
		const mounted = mountedMessage()
		const reply = (text: string, settled: boolean) =>
			createElement(MessageContent, { markdown: true, text, settled })
		try {
			mounted.render(reply('Almost', false))
			mounted.render(reply('Almost done.', true))
			expect(mounted.container.textContent).toBe('Almost done.')
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			mounted.unmount()
			vi.useRealTimers()
		}
	})
	it('keeps the parsed blocks of a growing reply and parses only its last block again', () => {
		vi.useFakeTimers()
		const mounted = mountedMessage()
		const live = (text: string) => createElement(MessageContent, { markdown: true, text })
		try {
			mounted.render(live('**One**\n\nTwo and'))
			act(() => vi.advanceTimersByTime(50))
			mounted.render(live('**One**\n\nTwo and three'))
			act(() => vi.advanceTimersByTime(50))
			mounted.render(live('**One**\n\nTwo and three\n\nFour'))
			act(() => vi.advanceTimersByTime(50))
			expect(parsed.mock.calls.map(([text]) => text)).toEqual([
				'**One**',
				'Two and',
				'Two and three',
				'Four',
			])
			expect(mounted.container.textContent).toBe('OneTwo and threeFour')
		} finally {
			mounted.unmount()
			vi.useRealTimers()
		}
	})
	it('keeps wrapper/theme attributes and text mode updates live around an unchanged parsed body', () => {
		const mounted = mountedMessage()
		const body = (text: string, markdown: boolean, theme: string) =>
			createElement(MessageContent, {
				markdown,
				text,
				settled: true,
				className: `theme-${theme}`,
				title: theme,
			})
		try {
			mounted.render(body('**Result**', true, 'light'))
			mounted.render(body('**Result**', true, 'dark'))
			expect(parsed).toHaveBeenCalledExactlyOnceWith('**Result**')
			expect(mounted.container.firstChild?.attributes.get('class')).toContain('theme-dark')
			expect(mounted.container.firstChild?.attributes.get('title')).toBe('dark')
			mounted.render(body('**Changed**', true, 'dark'))
			expect(parsed).toHaveBeenLastCalledWith('**Changed**')
			expect(mounted.container.textContent).toBe('Changed')
			mounted.render(body('**Changed** <button>Run</button>', false, 'dark'))
			expect(parsed).toHaveBeenCalledTimes(2)
			expect(mounted.container.textContent).toBe('**Changed** <button>Run</button>')
			mounted.render(body('**Changed**', true, 'dark'))
			expect(parsed).toHaveBeenCalledTimes(3)
			expect(mounted.container.textContent).toBe('Changed')
		} finally {
			mounted.unmount()
		}
	})
})
