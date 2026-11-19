import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	PERMISSIONS_POLICY,
	SCHEME,
	SCHEME_PRIVILEGES,
	contentPolicy,
	extensionHash,
	mimeOf,
	navigationAllowed,
	originOf,
	pagePath,
	partitionOf,
	requestAllowed,
	responseHeaders,
	serveAsset,
	sha256,
	viewWebPreferences,
} from './policy.js'

describe('origin and partition: one origin and one in-memory session per extension', () => {
	it('is stable, differs per extension, and carries no readable id', () => {
		expect(originOf('com.example.a')).toBe(originOf('com.example.a'))
		expect(originOf('com.example.a')).not.toBe(originOf('com.example.b'))
		expect(originOf('com.example.a')).toMatch(/^namzu-ext:\/\/x[0-9a-f]{16}$/)
		expect(extensionHash('com.example.a')).toMatch(/^x[0-9a-f]{16}$/)
		expect(originOf('com.example.a')).not.toContain('example')
	})
	it('the partition is not persistent and not shared', () => {
		expect(partitionOf('com.example.a')).toMatch(/^namzu-ext-[0-9a-f]{16}$/)
		expect(partitionOf('com.example.a')).not.toContain('persist:')
		expect(partitionOf('com.example.a')).not.toBe(partitionOf('com.example.b'))
	})
	it('the scheme is a secure standard origin with no service workers and no policy bypass', () => {
		expect(SCHEME).toBe('namzu-ext')
		expect(SCHEME_PRIVILEGES).toEqual({
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: false,
			bypassCSP: false,
			allowServiceWorkers: false,
		})
	})
})

describe('the content policy', () => {
	it('is the exact policy, with nothing but the page itself to connect to', () => {
		expect(contentPolicy()).toBe(
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self'",
		)
	})
	it('allows no inline script, no eval, no remote script or font, no frame, no worker, no form post', () => {
		const p = contentPolicy(['pages.example.com'])
		expect(p).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|script-src[^;]*https/)
		expect(p).toContain("script-src 'self'")
		expect(p).toContain("frame-src 'none'")
		expect(p).toContain("worker-src 'none'")
		expect(p).toContain("form-action 'none'")
		expect(p).toContain("object-src 'none'")
	})
	it('lists a declared host in connect-src and nowhere else', () => {
		const p = contentPolicy(['pages.example.com'])
		expect(p).toContain("connect-src 'self' https://pages.example.com")
		expect(p.match(/pages\.example\.com/g)).toHaveLength(1)
	})
	it('every response also carries the permissions policy and the isolation headers', () => {
		const h = responseHeaders()
		expect(h['Content-Security-Policy']).toBe(contentPolicy())
		expect(h['Permissions-Policy']).toBe(PERMISSIONS_POLICY)
		for (const f of [
			'camera',
			'microphone',
			'geolocation',
			'display-capture',
			'clipboard-read',
			'clipboard-write',
			'payment',
			'usb',
			'serial',
			'hid',
			'fullscreen',
		])
			expect(PERMISSIONS_POLICY).toContain(`${f}=()`)
		expect(h['X-Content-Type-Options']).toBe('nosniff')
		expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin')
		expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin')
		expect(h['Referrer-Policy']).toBe('no-referrer')
	})
})

describe('web preferences of a page: WebRTC', () => {
	it('tells the preload to close WebRTC unless the page declared a network', () => {
		expect(viewWebPreferences('p', '/x').additionalArguments).toEqual(['--namzu-ext-no-network=1'])
		expect(viewWebPreferences('p', '/x', false).additionalArguments).toEqual([
			'--namzu-ext-no-network=1',
		])
		expect(viewWebPreferences('p', '/x', true).additionalArguments).toEqual([])
	})
})

describe('web preferences of a page: written out, none inherited', () => {
	it('has no Node, runs in a sandbox with an isolated world, and cannot open a webview, a plugin or a dialog', () => {
		const p = viewWebPreferences('namzu-ext-abc', '/x/preload.cjs')
		expect(p).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInWorker: false,
			nodeIntegrationInSubFrames: false,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
			webviewTag: false,
			plugins: false,
			navigateOnDragDrop: false,
			spellcheck: false,
			enableWebSQL: false,
			safeDialogs: true,
			backgroundThrottling: true,
			autoplayPolicy: 'document-user-activation-required',
			partition: 'namzu-ext-abc',
			preload: '/x/preload.cjs',
		})
		expect(p.partition.startsWith('persist:')).toBe(false)
	})
})

describe('what a page may request', () => {
	const own = originOf('com.example.a')
	const other = originOf('com.example.b')
	const ctx = { origin: own, uiHosts: ['pages.example.com'], usesNetwork: false }
	it('its own files, data and blob images; nothing else without usesNetwork', () => {
		expect(requestAllowed(`${own}/ui/x.js`, ctx)).toBe(true)
		expect(requestAllowed('data:image/png;base64,AAAA', ctx)).toBe(true)
		expect(requestAllowed('blob:namzu-ext://x/1', ctx)).toBe(true)
		expect(requestAllowed('https://pages.example.com/a', ctx)).toBe(false)
	})
	it('a declared host only when the page uses the network, https on 443 only', () => {
		const net = { ...ctx, usesNetwork: true }
		expect(requestAllowed('https://pages.example.com/a', net)).toBe(true)
		expect(requestAllowed('https://pages.example.com:8443/a', net)).toBe(false)
		expect(requestAllowed('http://pages.example.com/a', net)).toBe(false)
		expect(requestAllowed('https://other.example.com/a', net)).toBe(false)
		expect(requestAllowed('wss://pages.example.com/a', net)).toBe(false)
	})
	it("never another extension, Namzu's own scheme, a file, devtools, a script URL or an address that is not one", () => {
		for (const u of [
			`${other}/ui/x.js`,
			'file:///etc/passwd',
			'devtools://devtools/bundled/x.html',
			'chrome://settings',
			'javascript:alert(1)',
			'ws://127.0.0.1:1/',
			'namzu://app/index.html',
			'not a url',
		])
			expect(requestAllowed(u, { ...ctx, usesNetwork: true })).toBe(false)
	})
	it("navigation stays on the page's own origin", () => {
		expect(navigationAllowed(`${own}/ui/other.html`, own)).toBe(true)
		expect(navigationAllowed(`${other}/ui/x.html`, own)).toBe(false)
		expect(navigationAllowed('https://example.com/', own)).toBe(false)
		expect(navigationAllowed('javascript:1', own)).toBe(false)
		expect(navigationAllowed('', own)).toBe(false)
	})
})

describe('serving a file of the package', () => {
	let dir: string
	const own = originOf('com.example.a')
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), 'ext-ui-')))
		mkdirSync(join(dir, 'ui', 'pages'), { recursive: true })
		writeFileSync(join(dir, 'ui', 'pages', 'today.html'), '<!doctype html><title>x</title>')
		writeFileSync(join(dir, 'ui', 'pages', 'today.js'), 'console.log(1)')
		writeFileSync(join(dir, 'secret.txt'), 'not in the list')
	})
	afterEach(() => {
		// the folder is under the test's temp area
	})
	const deps = (files: { path: string; sha256: string }[]) => ({
		dir,
		files,
		realpath: (p: string) => {
			try {
				return realpathSync(p)
			} catch {
				return undefined
			}
		},
		isRegularFile: (p: string) => {
			try {
				return statSync(p).isFile()
			} catch {
				return false
			}
		},
		read: (p: string) => readFileSync(p),
		join,
		sep,
	})
	const listed = () =>
		['ui/pages/today.html', 'ui/pages/today.js'].map((path) => ({
			path,
			sha256: sha256(readFileSync(join(dir, ...path.split('/')))),
		}))

	it('serves a listed file with the right type when its bytes hash to the signed value', () => {
		const a = serveAsset('ui/pages/today.html', deps(listed()), sha256)
		expect(a).toMatchObject({ status: 200, mime: 'text/html; charset=utf-8' })
		expect(serveAsset('ui/pages/today.js', deps(listed()), sha256)).toMatchObject({
			status: 200,
			mime: 'text/javascript; charset=utf-8',
		})
	})
	it('answers 404 for a file that is not in the list, even if it exists', () => {
		expect(serveAsset('secret.txt', deps(listed()), sha256)).toEqual({ status: 404 })
		expect(serveAsset('ui/pages/missing.js', deps(listed()), sha256)).toEqual({ status: 404 })
		expect(serveAsset(undefined, deps(listed()), sha256)).toEqual({ status: 404 })
	})
	it('answers 500 when a file changed after it was signed, so the page can be closed and audited', () => {
		const files = listed()
		writeFileSync(join(dir, 'ui', 'pages', 'today.js'), 'console.log(2)')
		expect(serveAsset('ui/pages/today.js', deps(files), sha256)).toEqual({
			status: 500,
			reason: 'ui-file-changed',
		})
	})
	it('a symlink, a folder and an unknown type are 404', () => {
		symlinkSync(join(dir, 'secret.txt'), join(dir, 'ui', 'pages', 'link.js'))
		const files = [
			...listed(),
			{ path: 'ui/pages/link.js', sha256: sha256(Buffer.from('not in the list')) },
			{ path: 'ui/pages', sha256: '0'.repeat(64) },
			{ path: 'ui/pages/today.exe', sha256: '0'.repeat(64) },
		]
		expect(serveAsset('ui/pages/link.js', deps(files), sha256)).toEqual({ status: 404 })
		expect(serveAsset('ui/pages', deps(files), sha256)).toEqual({ status: 404 })
		expect(serveAsset('ui/pages/today.exe', deps(files), sha256)).toEqual({ status: 404 })
	})
	it('a request path with dots, encoded dots or slashes, backslashes, a drive letter or NUL is refused before any file is looked at', () => {
		for (const u of [
			`${own}/../secret.txt`,
			`${own}/ui/a/../../secret.txt`,
			`${own}/ui/./pages/today.html`,
			`${own}/ui/%2e%2e/secret.txt`,
			`${own}/ui/..%2fsecret.txt`,
			`${own}/ui%5c..%5csecret.txt`,
			`${own}/C:/Windows/win.ini`,
			`${own}/ui/%00.js`,
			`${own}//etc/passwd`,
			`${originOf('com.example.b')}/ui/pages/today.html`,
			`${own}`,
		])
			expect(pagePath(u, own), u).toBeUndefined()
		expect(pagePath(`${own}/ui/pages/today.html`, own)).toBe('ui/pages/today.html')
		expect(mimeOf('a.SVG')).toBe('image/svg+xml')
		expect(mimeOf('a.exe')).toBeUndefined()
	})
})
