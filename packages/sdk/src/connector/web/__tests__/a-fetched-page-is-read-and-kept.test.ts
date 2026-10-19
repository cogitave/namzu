import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type CachedPage,
	WEB_PAGE_CONVERT_MAX_CHARS,
	WEB_PAGE_TRUNCATED_MARKER,
	WebPageCache,
	htmlToMarkdown,
	isSameSiteRedirect,
} from '../page.js'

afterEach(() => {
	vi.useRealTimers()
})

describe('which redirects stay on the site', () => {
	const same = (from: string, to: string) => isSameSiteRedirect(new URL(from), new URL(to))

	it('keeps a change of path or query', () => {
		expect(same('https://example.com/a', 'https://example.com/b?x=1#top')).toBe(true)
	})

	it('keeps www. coming or going', () => {
		expect(same('https://example.com/', 'https://www.example.com/home')).toBe(true)
		expect(same('https://www.example.com/', 'https://example.com/')).toBe(true)
	})

	it('keeps an upgrade from http to https on the same host', () => {
		expect(same('http://example.com/', 'https://example.com/')).toBe(true)
	})

	it('does not keep a downgrade from https to http', () => {
		expect(same('https://example.com/', 'http://example.com/')).toBe(false)
	})

	it('does not keep another host, a subdomain, or a lookalike', () => {
		expect(same('https://example.com/', 'https://other.example/')).toBe(false)
		expect(same('https://example.com/', 'https://docs.example.com/')).toBe(false)
		expect(same('https://example.com/', 'https://example.com.evil.test/')).toBe(false)
	})

	it('does not keep another port', () => {
		expect(same('https://example.com/', 'https://example.com:8443/')).toBe(false)
		expect(same('http://example.com/', 'https://example.com:8443/')).toBe(false)
	})

	it('does not keep a target that carries credentials', () => {
		expect(same('https://example.com/', 'https://user:pw@example.com/')).toBe(false)
	})
})

describe('turning HTML into markdown', () => {
	it('keeps headings, emphasis, links and lists, and drops what a reader never sees', async () => {
		const markdown = await htmlToMarkdown(
			'<h1>Title</h1><p>A <em>soft</em> and <strong>hard</strong> <a href="/x">link</a>.</p><ul><li>one</li><li>two</li></ul><style>p{}</style><script>boom()</script><noscript>js off</noscript><iframe src="/f"></iframe>',
		)

		expect(markdown).toContain('Title\n=====')
		expect(markdown).toContain('_soft_')
		expect(markdown).toContain('**hard**')
		expect(markdown).toContain('[link](/x)')
		expect(markdown).toMatch(/\* {3}one/u)
		expect(markdown).not.toContain('boom')
		expect(markdown).not.toContain('js off')
		expect(markdown).not.toContain('p{}')
	})

	it('cuts input past the converter limit and says so', async () => {
		const html = `<p>${'a '.repeat(WEB_PAGE_CONVERT_MAX_CHARS)}</p>`

		const markdown = await htmlToMarkdown(html)

		expect(markdown.endsWith(WEB_PAGE_TRUNCATED_MARKER)).toBe(true)
		expect(markdown.length).toBeLessThan(WEB_PAGE_CONVERT_MAX_CHARS + 100)
	})

	it('hands text that has no markup back as it is', async () => {
		expect(await htmlToMarkdown('just words')).toBe('just words')
	})
})

describe('the page cache', () => {
	const page = (content: string): CachedPage => ({
		content,
		status: 200,
		url: 'https://example.com/',
		redirects: ['https://example.com/'],
		truncated: false,
		bytes: content.length,
	})

	it('returns a page until its time is up, and not after', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(0)
		const cache = new WebPageCache(1000, 1_000_000)

		cache.set('u', page('hello'))
		vi.setSystemTime(999)
		expect(cache.get('u')?.content).toBe('hello')
		vi.setSystemTime(1000)
		expect(cache.get('u')).toBeUndefined()
	})

	it('replaces a page set again under the same URL', () => {
		const cache = new WebPageCache(1000, 1_000_000)
		cache.set('u', page('old'))
		cache.set('u', page('new'))
		expect(cache.get('u')?.content).toBe('new')
	})

	it('drops the least recently used page first when the byte cap is reached', () => {
		const cache = new WebPageCache(60_000, 10)
		cache.set('a', page('aaaa'))
		cache.set('b', page('bbbb'))
		cache.get('a') // a is now newer than b
		cache.set('c', page('cccc'))

		expect(cache.get('b')).toBeUndefined()
		expect(cache.get('a')?.content).toBe('aaaa')
		expect(cache.get('c')?.content).toBe('cccc')
	})

	it('does not keep a page larger than the whole cache', () => {
		const cache = new WebPageCache(60_000, 3)
		cache.set('big', page('too big for this'))
		expect(cache.get('big')).toBeUndefined()
	})
})
