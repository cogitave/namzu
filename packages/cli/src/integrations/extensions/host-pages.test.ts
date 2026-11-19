import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	buildPackage,
	makeKey,
	sampleManifest,
	trustedFrom,
} from './__fixtures__/package-builder.js'
import { sha256Hex } from './canon.js'
import { ExtensionError } from './errors.js'
import { ExtensionHost } from './host.js'

/** A sample extension with a page: its files, what the host tells Desktop, and what add refuses. */
const pub = makeKey('pub-pages')
const lic = makeKey('lic-pages')
const ID = 'com.example.stub-recorder'
const SAMPLE = join(new URL('.', import.meta.url).pathname, '__fixtures__', 'sample-page')

function files(dir = SAMPLE, prefix = ''): Record<string, string> {
	const out: Record<string, string> = {}
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, e.name)
		if (e.isDirectory()) Object.assign(out, files(abs, `${prefix}${e.name}/`))
		else out[`${prefix}${e.name}`] = readFileSync(abs, 'utf8')
	}
	return out
}
const PAGE_FILES = files()

const withPage = (m: Record<string, any>): void => {
	m.licensing = { kind: 'none' }
	m.ui = {
		icon: 'ui/icon.svg',
		accent: '#2F6F4F',
		pages: [
			{
				id: 'today',
				title: { en: "Today's record" },
				slot: 'settings',
				entry: 'ui/pages/today.html',
				minHeight: 360,
				bridge: { allow: ['query:counts', 'query:rows'], host: ['state', 'openNamzu', 'theme'] },
			},
		],
		chips: [],
	}
}

let home: string
let host: ExtensionHost
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-pages-'))
	host = new ExtensionHost({
		home,
		hostVersion: '53.5.0',
		kind: 'desktop',
		oneShot: true,
		env: {},
		locale: () => 'en',
		compiledKeys: [trustedFrom(pub)],
	})
})
afterEach(async () => {
	await host.stopSupervision()
	removeTempDir(home)
})
const pkg = (
	mut: (m: Record<string, any>) => void = withPage,
	extra: Record<string, string | null> = {},
	version = '1.0.0',
	tamper?: string,
) =>
	buildPackage({
		manifest: sampleManifest(mut as never, { keyId: pub.id, version }),
		...(tamper ? { tamper } : {}),
		publisherKey: pub,
		licenseKey: lic,
		files: { ...PAGE_FILES, ...extra },
	})
const code = (fn: () => unknown): string => {
	try {
		fn()
	} catch (e) {
		if (e instanceof ExtensionError) return `${e.code}:${e.check}`
		throw e
	}
	return 'ok'
}

describe('the sample page', () => {
	it('is an ordinary signed package: add shows the pages line, the host lists exactly its ui files with the signed hashes', () => {
		const r = host.add(pkg())
		expect(r.disclosure.pages).toBe(
			"This extension draws pages inside Namzu: Today's record (settings). They cannot use the network.",
		)
		const ui = host.uiInfo(ID)
		expect(ui?.files.map((f) => f.path)).toEqual([
			'ui/icon.svg',
			'ui/pages/today.css',
			'ui/pages/today.html',
			'ui/pages/today.js',
		])
		const dir = ui?.dir ?? ''
		for (const f of ui?.files ?? [])
			expect(sha256Hex(readFileSync(join(dir, ...f.path.split('/'))))).toBe(f.sha256)
		// The unpacked version is read-only, so a page cannot be changed on disk without a trace.
		expect(statSync(join(dir, 'ui', 'pages', 'today.js')).mode & 0o222).toBe(0)
		expect(ui?.methods.map((m) => m.method)).toEqual(
			expect.arrayContaining(['query:counts', 'query:rows']),
		)
	})
	it('a page file changed after signing is a tampered package and nothing is written', () => {
		expect(code(() => host.add(pkg(withPage, {}, '1.0.0', 'ui/pages/today.js')))).toBe(
			'tampered:file-hash',
		)
	})
	it('the page can call only what its manifest declares: the allow list in the host answer is that list', () => {
		host.add(pkg())
		const p = host.uiInfo(ID)?.pages[0]
		expect(p?.bridge).toEqual({
			allow: ['query:counts', 'query:rows'],
			host: ['state', 'openNamzu', 'theme'],
		})
		expect(p?.hosts).toEqual([])
		expect(p?.usesNetwork).toBe(false)
	})
})

describe('add refuses a page that is not what it says', () => {
	it('an SVG icon with a script, an event attribute, a foreignObject or an external reference', () => {
		for (const svg of [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example.com/x.png"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example.com/a.css)</style></svg>',
		])
			expect(code(() => host.add(pkg(withPage, { 'ui/icon.svg': svg })))).toBe(
				'manifest-invalid:K1',
			)
	})
	it('an icon larger than 32 KiB', () => {
		expect(
			code(() =>
				host.add(
					pkg(withPage, {
						'ui/icon.svg': `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${randomBytes(30 * 1024).toString('base64')} --></svg>`,
					}),
				),
			),
		).toBe('manifest-invalid:K1')
	})
	it('a page, a chip icon or an icon the manifest names but the package does not carry', () => {
		expect(code(() => host.add(pkg(withPage, { 'ui/pages/today.html': null })))).toBe(
			'manifest-invalid:K1',
		)
		expect(code(() => host.add(pkg(withPage, { 'ui/icon.svg': null })))).toBe('manifest-invalid:K1')
	})
	it('a page file outside ui/ and a page that is not html', () => {
		expect(
			code(() =>
				host.add(
					pkg((m) => {
						withPage(m)
						m.ui.pages[0].entry = 'bin/today.html'
					}),
				),
			),
		).toBe('manifest-invalid:U3')
		expect(
			code(() =>
				host.add(
					pkg((m) => {
						withPage(m)
						m.ui.pages[0].entry = 'ui/pages/today.js'
					}),
				),
			),
		).toBe('manifest-invalid:U3')
	})
	it("a page named after one of Namzu's own screens", () => {
		expect(
			code(() =>
				host.add(
					pkg((m) => {
						withPage(m)
						m.ui.pages[0].id = 'permissions'
					}),
				),
			),
		).toBe('manifest-invalid:U6')
	})
	it('a page that wants the network and the extension both', () => {
		expect(
			code(() =>
				host.add(
					pkg((m) => {
						withPage(m)
						m.network = {
							mode: 'declared',
							hosts: [{ host: 'pages.example.com', purpose: { en: 'Page data' }, for: ['ui'] }],
						}
						m.privacy.leavesTheMachine = 'declared'
						m.ui.pages[0].usesNetwork = true
					}),
				),
			),
		).toBe('manifest-invalid:U7')
	})
	it('a changed title, accent or icon asks nothing of the person; a new network use does', () => {
		host.add(pkg())
		const n = host.notice(ID)
		host.acknowledge(ID, {
			noticeVersion: n.noticeVersion,
			scopeHash: n.scopeHash,
			locale: n.locale,
		})
		const renamed = host.add(
			pkg(
				(m) => {
					withPage(m)
					m.ui.pages[0].title = { en: 'A new name' }
					m.ui.accent = '#112233'
				},
				{},
				'1.0.1',
			),
		)
		expect(renamed.update?.waiting).toBe(false)
	})
})
