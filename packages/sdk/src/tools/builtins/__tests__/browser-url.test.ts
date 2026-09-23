import { describe, expect, it } from 'vitest'
import {
	canonicalizeBrowserOrigin,
	canonicalizeBrowserSitePattern,
	canonicalizeBrowserUrl,
	isCloudMetadataHost,
} from '../browser-url.js'

function url(raw: string): string {
	const verdict = canonicalizeBrowserUrl(raw)
	if (!verdict.ok) throw new Error(`refused ${raw}: ${verdict.reason}`)
	return verdict.url
}

function refused(raw: string): string {
	const verdict = canonicalizeBrowserUrl(raw)
	if (verdict.ok) throw new Error(`accepted ${raw} as ${verdict.url}`)
	return verdict.reason
}

describe('canonicalizeBrowserUrl: one spelling per address', () => {
	it.each([
		['HTTPS://GitHub.com:443/x', 'https://github.com/x'],
		['http://a.example:80/', 'http://a.example/'],
		['https://github.com./', 'https://github.com/'],
		['https://github.com../a', 'https://github.com/a'],
		['https://%67ithub.com/', 'https://github.com/'],
		['https:github.com', 'https://github.com/'],
		['https://ｇｉｔｈｕｂ.com/', 'https://github.com/'],
		['  https://github.com/a b  ', 'https://github.com/a%20b'],
		['https://a.example\\@evil.example/', 'https://a.example/@evil.example/'],
		['http://0x7f.1/', 'http://127.0.0.1/'],
		['https://example.com:8443/p?q=1#h', 'https://example.com:8443/p?q=1#h'],
		['ABOUT:BLANK', 'about:blank'],
	])('%s -> %s', (raw, expected) => {
		expect(url(raw)).toBe(expected)
	})

	it('punycodes an internationalised host, so a lookalike cannot pass as the real one', () => {
		// Cyrillic "і" in place of Latin "i".
		const lookalike = url('https://gіthub.com/')
		expect(lookalike).toMatch(/^https:\/\/xn--/)
		expect(new URL(lookalike).hostname).not.toBe('github.com')
		expect(url('https://bücher.example/')).toBe('https://xn--bcher-kva.example/')
	})

	it('keeps a lookalike host whole, so an anchored site pattern cannot match it', () => {
		const pattern = /^https:\/\/github\.com(?:[/?#]|$)/
		for (const raw of [
			'https://github.com.evil.example/',
			'https://evil.example/?https://github.com',
			'https://githubXcom.example/',
		]) {
			expect(pattern.test(url(raw)), raw).toBe(false)
		}
		expect(pattern.test(url('HTTPS://GITHUB.COM.:443'))).toBe(true)
	})

	it.each([
		['https://github.com@evil.example/', /user name or password/],
		['https://user:pass@example.com/', /user name or password/],
		['https://:pass@example.com/', /user name or password/],
		['file:///etc/passwd', /scheme "file:"/],
		['chrome://settings', /scheme "chrome:"/],
		['devtools://devtools/bundled/inspector.html', /scheme "devtools:"/],
		['view-source:https://example.com', /scheme "view-source:"/],
		['javascript:alert(1)', /scheme "javascript:"/],
		['JavaScript:alert(1)', /scheme "javascript:"/],
		['data:text/html,<script>alert(1)</script>', /scheme "data:"/],
		['ftp://example.com/', /scheme "ftp:"/],
		['ws://example.com/', /scheme "ws:"/],
		['blob:https://example.com/uuid', /scheme "blob:"/],
		['about:config', /only about:blank/],
		['about:blank#x', /only about:blank/],
		['/relative/path', /not an absolute URL/],
		['example.com', /not an absolute URL/],
		['', /empty/],
		['   ', /empty/],
	])('refuses %s', (raw, reason) => {
		expect(refused(raw)).toMatch(reason)
	})

	it('refuses an address longer than the limit', () => {
		expect(refused(`https://example.com/${'a'.repeat(9000)}`)).toMatch(/longer than/)
	})
})

describe('the cloud metadata floor', () => {
	// Every one of these is 169.254.169.254 (or another metadata endpoint) to
	// the browser. A canonicaliser that compared strings before parsing would
	// wave each through.
	it.each([
		'http://169.254.169.254/latest/meta-data/',
		'http://169.254.169.254:80/',
		'http://169.254.169.254./',
		'https://169.254.169.254/',
		'http://2852039166/',
		'http://0xA9FEA9FE/',
		'http://0xa9.0xfe.0xa9.0xfe/',
		'http://0251.0376.0251.0376/',
		'http://0251.254.169.254/',
		'http://169.254.43518/',
		'http://169.16689662/',
		'http://%31%36%39.254.169.254/',
		'http://①⑥⑨.254.169.254/',
		'http://169。254。169。254/',
		'http://[::ffff:169.254.169.254]/',
		'http://[::ffff:a9fe:a9fe]/',
		'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
		'http://[::169.254.169.254]/',
		'http://[::ffff:0:169.254.169.254]/',
		'http://[64:ff9b::169.254.169.254]/',
		'http://[64:ff9b:1::a9fe:a9fe]/',
		'http://[2002:a9fe:a9fe::1]/',
		'http://[fd00:ec2::254]/',
		'http://[FD00:0EC2:0:0:0:0:0:0254]/',
		'http://metadata.google.internal/computeMetadata/v1/',
		'http://METADATA.GOOGLE.INTERNAL./',
		'http://metadata/',
		'http://100.100.100.200/',
		'http://1684301000/',
	])('refuses %s', (raw) => {
		expect(refused(raw)).toMatch(/cloud metadata endpoint/)
	})

	it.each([
		'http://169.254.169.253/',
		'http://169.254.169.254.nip.io/',
		'http://[::ffff:a9fe:a9fd]/',
		'http://127.0.0.1/',
		'http://10.0.0.1/',
		'http://[::1]/',
		'http://metadata.example.com/',
	])('leaves %s to the site rules', (raw) => {
		expect(canonicalizeBrowserUrl(raw).ok).toBe(true)
	})

	it('answers for a bare host as well as a URL host', () => {
		expect(isCloudMetadataHost('169.254.169.254')).toBe(true)
		expect(isCloudMetadataHost('[fd00:ec2::254]')).toBe(true)
		expect(isCloudMetadataHost('fd00:ec2::254')).toBe(true)
		expect(isCloudMetadataHost('::ffff:169.254.169.254')).toBe(true)
		expect(isCloudMetadataHost('example.com')).toBe(false)
		expect(isCloudMetadataHost('')).toBe(false)
		expect(isCloudMetadataHost('[not an address')).toBe(false)
	})
})

describe('canonicalizeBrowserOrigin', () => {
	it.each([
		['https://GitHub.com', 'https://github.com'],
		['https://github.com/', 'https://github.com'],
		['https://github.com.:443', 'https://github.com'],
		['http://localhost:3000', 'http://localhost:3000'],
		['https://bücher.example', 'https://xn--bcher-kva.example'],
	])('%s -> %s', (raw, expected) => {
		expect(canonicalizeBrowserOrigin(raw)).toEqual({ ok: true, origin: expected })
	})

	it.each([
		['https://github.com/login', /not an origin/],
		['https://github.com/?a=1', /not an origin/],
		['https://github.com/#x', /not an origin/],
		['about:blank', /no origin/],
		['https://user@github.com', /user name or password/],
		['http://169.254.169.254', /metadata/],
		['github.com', /not an absolute URL/],
	])('refuses %s', (raw, reason) => {
		const verdict = canonicalizeBrowserOrigin(raw)
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) expect(verdict.reason).toMatch(reason)
	})
})

describe('canonicalizeBrowserSitePattern', () => {
	it.each([
		['https://github.com', 'https://github.com'],
		['HTTPS://GitHub.com/', 'https://github.com'],
		['https://github.com:443', 'https://github.com'],
		['https://*.Example.com', 'https://*.example.com'],
		['http://localhost:*', 'http://localhost:*'],
		['http://localhost:8080', 'http://localhost:8080'],
		['https://*.bücher.example', 'https://*.xn--bcher-kva.example'],
		['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
	])('%s -> %s', (raw, expected) => {
		expect(canonicalizeBrowserSitePattern(raw)).toEqual({ ok: true, pattern: expected })
	})

	it.each([
		['*', /not a site/],
		['github.com', /not a site/],
		['https://github.com/path', /not a site/],
		['https://user@github.com', /not a site/],
		['ftp://example.com', /scheme/],
		['https://*', /wildcard/],
		['http://169.254.169.254', /metadata/],
		['https://*.10.0.0.1', /wildcard/],
		['https://*github.com', /wildcard/],
	])('refuses %s', (raw, reason) => {
		const verdict = canonicalizeBrowserSitePattern(raw)
		expect(verdict.ok, raw).toBe(false)
		if (!verdict.ok) expect(verdict.reason).toMatch(reason)
	})
})
