import { describe, expect, it } from 'vitest'
import { BrowserSitePolicy, BrowserSitePolicyError } from '../policy.js'

describe('BrowserSitePolicy.levelOf', () => {
	const policy = new BrowserSitePolicy({
		'https://github.com': 'act',
		'https://*.github.com': 'read',
		'https://gist.github.com': 'deny',
		'http://localhost:*': 'act',
		'https://*.example.com': 'deny',
		'https://shop.example.com': 'act',
		'*': 'ask',
	})

	it('matches exact origins, wildcards and any-port keys', () => {
		expect(policy.levelOf('https://github.com')).toBe('act')
		expect(policy.levelOf('https://api.github.com')).toBe('read')
		expect(policy.levelOf('https://a.b.github.com')).toBe('read')
		expect(policy.levelOf('http://localhost:5173')).toBe('act')
		expect(policy.levelOf('http://localhost')).toBe('act')
	})

	it('lets a deny win over a more specific allow', () => {
		expect(policy.levelOf('https://gist.github.com')).toBe('deny')
		expect(policy.levelOf('https://shop.example.com')).toBe('deny')
	})

	it('does not read a look-alike as the site', () => {
		expect(policy.levelOf('https://github.com.evil.example')).toBe('ask')
		expect(policy.levelOf('https://evilgithub.com')).toBe('ask')
		expect(policy.levelOf('http://github.com')).toBe('ask')
		expect(policy.levelOf('https://github.com:8443')).toBe('ask')
		// `*.` is one or more labels, never the bare domain.
		expect(
			new BrowserSitePolicy({ 'https://*.example.org': 'act' }).levelOf('https://example.org'),
		).toBe('ask')
	})

	it('treats a default port as no port', () => {
		const p = new BrowserSitePolicy({ 'https://github.com:443': 'act', '*': 'deny' })
		expect(p.levelOf('https://github.com')).toBe('act')
	})

	it('falls back to ask without a * key, and denies non-web schemes', () => {
		const p = new BrowserSitePolicy({})
		expect(p.levelOf('https://anything.example')).toBe('ask')
		expect(p.levelOf('file:///etc/passwd')).toBe('deny')
		expect(p.levelOf('not a url')).toBe('deny')
	})

	it('refuses malformed keys and levels', () => {
		expect(() => new BrowserSitePolicy({ 'github.com': 'act' })).toThrow(BrowserSitePolicyError)
		expect(() => new BrowserSitePolicy({ 'https://git*.com': 'act' })).toThrow(
			BrowserSitePolicyError,
		)
		expect(() => new BrowserSitePolicy({ 'https://github.com': 'allow' as never })).toThrow(
			BrowserSitePolicyError,
		)
	})
})

describe('BrowserSitePolicy.canAct', () => {
	const policy = new BrowserSitePolicy({
		'https://read.example': 'read',
		'https://ask.example': 'ask',
		'https://act.example': 'act',
		'https://deny.example': 'deny',
	})

	it('acts only at ask (the gate reviewed it) and act', () => {
		expect(policy.canAct('https://act.example')).toBe(true)
		expect(policy.canAct('https://ask.example')).toBe(true)
		expect(policy.canAct('https://read.example')).toBe(false)
		expect(policy.canAct('https://deny.example')).toBe(false)
	})
})

describe('BrowserSitePolicy.landing', () => {
	it('keeps about:blank and pages at read or act', () => {
		const p = new BrowserSitePolicy({ 'https://docs.example': 'read', '*': 'ask' })
		expect(p.landing('about:blank').allowed).toBe(true)
		expect(p.landing('https://docs.example/page?q=1').allowed).toBe(true)
	})

	it('clears an ask origin nobody asked for, and keeps it once asked', () => {
		const p = new BrowserSitePolicy({ '*': 'ask' })
		const before = p.landing('https://elsewhere.example/x')
		expect(before.allowed).toBe(false)
		expect(before.origin).toBe('https://elsewhere.example')
		p.approve('https://elsewhere.example')
		expect(p.landing('https://elsewhere.example/y').allowed).toBe(true)
	})

	it('never keeps a denied origin, even one asked for', () => {
		const p = new BrowserSitePolicy({ 'https://bad.example': 'deny', '*': 'act' })
		p.approve('https://bad.example')
		expect(p.landing('https://bad.example/').allowed).toBe(false)
	})

	it('refuses non-web schemes and metadata addresses', () => {
		const p = new BrowserSitePolicy({ '*': 'act' })
		expect(p.landing('file:///etc/passwd').allowed).toBe(false)
		expect(p.landing('chrome://settings').allowed).toBe(false)
		expect(p.landing('data:text/html,hi').allowed).toBe(false)
		expect(p.landing('about:settings').allowed).toBe(false)
		expect(p.landing('http://169.254.169.254/latest/meta-data/').allowed).toBe(false)
		expect(p.landing('http://metadata.google.internal/').allowed).toBe(false)
	})

	it('judges a blob: document by the origin inside it', () => {
		const p = new BrowserSitePolicy({ 'https://app.example': 'act', '*': 'deny' })
		expect(p.landing('blob:https://app.example/1234-5678').allowed).toBe(true)
		expect(p.landing('blob:https://other.example/1234-5678').allowed).toBe(false)
	})
})
