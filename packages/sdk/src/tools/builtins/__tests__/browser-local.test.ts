import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type {
	BrowserActAction,
	BrowserHost,
	BrowserObserveAction,
	BrowserResult,
} from '../../../types/browser/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import {
	LocalPageRefusal,
	LocalPageServers,
	readLocalPageReference,
	resolveLocalPage,
	secretPathReason,
} from '../browser-local.js'
import { closeBrowserLocalPages, createBrowserTools } from '../browser.js'

describe('readLocalPageReference', () => {
	it.each([
		['site/index.html', 'site/index.html', ''],
		['./index.html', './index.html', ''],
		['../x/index.html', '../x/index.html', ''],
		['/home/a/site/index.html', '/home/a/site/index.html', ''],
		['C:/Users/a/site/index.html', 'C:/Users/a/site/index.html', ''],
		['C:\\Users\\a\\site\\index.html', 'C:\\Users\\a\\site\\index.html', ''],
		['d:\\site\\index.html', 'd:\\site\\index.html', ''],
		['file:///home/a/site/index.html', '/home/a/site/index.html', ''],
		['FILE:///home/a/site/my%20page.html?x=1#top', '/home/a/site/my page.html', '?x=1#top'],
		['file:///C:/Users/a/site/index.html', 'C:/Users/a/site/index.html', ''],
		['file:///c:/Users/a/index.html#s', 'c:/Users/a/index.html', '#s'],
		['file:C:/Users/a/index.html', 'C:/Users/a/index.html', ''],
		['file://localhost/home/a/index.html', '/home/a/index.html', ''],
	])('reads %s', (raw, path, suffix) => {
		expect(readLocalPageReference(raw)).toEqual({ ok: true, path, suffix })
	})

	it.each([
		'https://example.com/',
		'http://localhost:3000/x',
		'about:blank',
		'javascript:alert(1)',
		'data:text/html,hi',
		'ftp://host/x',
		'',
		'   ',
	])('leaves %j to the web-address rules', (raw) => {
		expect(readLocalPageReference(raw)).toBeUndefined()
	})

	it.each([
		['file://server/share/index.html', /another machine/],
		['\\\\server\\share\\index.html', /network share/],
		['//server/share/index.html', /network share/],
		['file:///home/a/%zz.html', /percent-escape/],
	])('refuses %s', (raw, reason) => {
		const read = readLocalPageReference(raw)
		expect(read?.ok).toBe(false)
		if (read && !read.ok) expect(read.reason).toMatch(reason)
	})
})

describe('secretPathReason', () => {
	it.each([
		[['.git', 'config']],
		[['site', '.git', 'HEAD']],
		[['.env']],
		[['site', '.env.production']],
		[['id_rsa']],
		[['keys', 'server.pem']],
		[['.ssh', 'known_hosts']],
		[['credentials.json']],
		[['.npmrc']],
	])('refuses %j', (segments) => {
		expect(secretPathReason(segments)).toBeDefined()
	})

	it.each([[['index.html']], [['assets', 'app.js']], [['.env.example']], [['gitignore.txt']]])(
		'allows %j',
		(segments) => {
			expect(secretPathReason(segments)).toBeUndefined()
		},
	)
})

let base: string
let work: string
let outside: string
const servers: LocalPageServers[] = []

beforeAll(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), 'namzu-local-page-')))
	work = join(base, 'work')
	outside = join(base, 'outside')
	await mkdir(join(work, 'site', 'img'), { recursive: true })
	await mkdir(join(work, '.git'), { recursive: true })
	await mkdir(join(work, 'emptydir'), { recursive: true })
	await mkdir(outside, { recursive: true })
	await writeFile(
		join(work, 'site', 'index.html'),
		'<link rel="stylesheet" href="style.css"><img src="img/dot.png"><h1>Hello</h1>',
	)
	await writeFile(join(work, 'site', 'style.css'), 'h1 { color: red }')
	await writeFile(join(work, 'site', 'img', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
	await writeFile(join(work, 'site', 'my page.html'), '<p>spaced</p>')
	await writeFile(join(work, 'site', '.env'), 'TOKEN=1')
	await writeFile(join(work, '.git', 'config'), '[core]')
	await writeFile(join(work, 'top.html'), '<p>top</p>')
	await writeFile(join(outside, 'secret.html'), '<p>outside</p>')
	await symlink(join(outside, 'secret.html'), join(work, 'site', 'escape.html'))
	await symlink(outside, join(work, 'site', 'escape-dir'))
	await symlink(join(work, 'site', '.env'), join(work, 'site', 'innocent.html'))
	await symlink(join(work, 'top.html'), join(work, 'site', 'inside-link.html'))
})

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()))
})

afterAll(async () => {
	await rm(base, { recursive: true, force: true })
})

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
		workingDirectory: work,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extra,
	}
}

function newServers(): LocalPageServers {
	const s = new LocalPageServers()
	servers.push(s)
	return s
}

async function refusedWith(path: string, context: ToolContext = ctx()): Promise<string> {
	try {
		await resolveLocalPage({ path }, context)
	} catch (error) {
		expect(error).toBeInstanceOf(LocalPageRefusal)
		return (error as Error).message
	}
	throw new Error(`${path} was not refused`)
}

describe('resolveLocalPage', () => {
	it('resolves a relative and an absolute path to the same file', async () => {
		const relative = await resolveLocalPage({ path: 'site/index.html' }, ctx())
		const absolute = await resolveLocalPage({ path: join(work, 'site', 'index.html') }, ctx())
		expect(relative).toEqual({ root: work, segments: ['site', 'index.html'] })
		expect(absolute).toEqual(relative)
	})

	it('opens a folder through its index.html and follows a link that stays inside', async () => {
		expect((await resolveLocalPage({ path: 'site' }, ctx())).segments).toEqual([
			'site',
			'index.html',
		])
		expect((await resolveLocalPage({ path: 'site/inside-link.html' }, ctx())).segments).toEqual([
			'top.html',
		])
	})

	it('refuses a path outside the folders, and says what is allowed', async () => {
		const message = await refusedWith(join(outside, 'secret.html'))
		expect(message).toMatch(/outside the folders local pages open from/)
		expect(message).toContain(work)
		expect(message).toMatch(/scratch folder/)
	})

	it('refuses ../ out of the work folder', async () => {
		expect(await refusedWith('../outside/secret.html')).toMatch(/outside the folders/)
		expect(await refusedWith('site/../../outside/secret.html')).toMatch(/outside the folders/)
	})

	it('refuses a symlink that escapes the folder, file or directory', async () => {
		expect(await refusedWith('site/escape.html')).toMatch(/link that leads outside/)
		expect(await refusedWith('site/escape-dir/secret.html')).toMatch(/link that leads outside/)
	})

	it('refuses .git, a secret file, and a link that points at one', async () => {
		expect(await refusedWith('.git/config')).toMatch(/\.git folder/)
		expect(await refusedWith('site/.env')).toMatch(/secret file/)
		expect(await refusedWith('site/innocent.html')).toMatch(/secret file/)
	})

	it("refuses what the session's read rules deny", async () => {
		const message = await refusedWith(
			'top.html',
			ctx({ readDenied: (p) => p.endsWith('top.html') }),
		)
		expect(message).toMatch(/read rules/)
	})

	it('refuses a missing file, a folder with no index, and a Windows path on this platform', async () => {
		expect(await refusedWith('site/nope.html')).toMatch(/no file at/)
		expect(await refusedWith('emptydir')).toMatch(/never listed/)
		await expect(
			resolveLocalPage({ path: 'C:/Users/a/index.html' }, ctx(), 'linux'),
		).rejects.toThrow(/Windows path/)
	})

	it('accepts a folder the session added', async () => {
		const target = await resolveLocalPage(
			{ path: join(outside, 'secret.html') },
			ctx({ additionalDirectories: [outside] }),
		)
		expect(target.root).toBe(outside)
	})
})

describe('LocalPageServers', () => {
	async function serve(path: string, s = newServers()) {
		const target = await resolveLocalPage({ path }, ctx())
		return { url: await s.urlFor(target), s }
	}

	it('serves the page and its relative stylesheet and image from 127.0.0.1', async () => {
		const { url } = await serve('site/index.html')
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/site\/index\.html$/)
		const page = await fetch(url)
		expect(page.status).toBe(200)
		expect(page.headers.get('content-type')).toMatch(/^text\/html/)
		expect(await page.text()).toContain('Hello')
		const css = await fetch(new URL('style.css', url))
		expect(css.headers.get('content-type')).toMatch(/^text\/css/)
		expect(await css.text()).toBe('h1 { color: red }')
		const png = await fetch(new URL('img/dot.png', url))
		expect(png.headers.get('content-type')).toBe('image/png')
		expect(png.status).toBe(200)
	})

	it('keeps the query and fragment, and encodes a name with a space', async () => {
		const s = newServers()
		const target = await resolveLocalPage({ path: 'site/my page.html' }, ctx())
		const url = await s.urlFor(target, '?a=1#top')
		expect(url).toMatch(/site\/my%20page\.html\?a=1#top$/)
		expect(await (await fetch(url)).text()).toBe('<p>spaced</p>')
	})

	it('cannot be made to read a file outside the root, however the request is spelled', async () => {
		const { url } = await serve('site/index.html')
		const root = new URL('../../', url)
		const token = url.split('/')[3]
		const base = `${new URL(url).origin}/${token}/`
		// Raw sockets, so the client does not tidy the dots away before the server sees them.
		const raw = async (path: string): Promise<number> => {
			const { request } = await import('node:http')
			return new Promise((ok, fail) => {
				const u = new URL(url)
				const req = request(
					{ host: '127.0.0.1', port: Number(u.port), path, method: 'GET' },
					(res) => {
						res.resume()
						res.on('end', () => ok(res.statusCode ?? 0))
					},
				)
				req.on('error', fail)
				req.end()
			})
		}
		const prefix = `/${token}`
		for (const path of [
			`${prefix}/../outside/secret.html`,
			`${prefix}/site/../../outside/secret.html`,
			`${prefix}/%2e%2e/outside/secret.html`,
			`${prefix}/site/%2e%2e/%2e%2e/outside/secret.html`,
			`${prefix}/site/..%2f..%2foutside/secret.html`,
			`${prefix}/site/escape.html`,
			`${prefix}/site/escape-dir/secret.html`,
			`${prefix}/site/.env`,
			`${prefix}/site/innocent.html`,
			`${prefix}/.git/config`,
			'/outside/secret.html',
			'/',
			'/wrong-token/site/index.html',
		]) {
			expect([400, 403, 404], path).toContain(await raw(path))
		}
		// The same through the browser's own fetch, which normalises dots first.
		for (const rel of ['../outside/secret.html', 'site/escape.html', 'site/.env', '.git/config']) {
			const response = await fetch(new URL(rel, base))
			expect(response.status, rel).not.toBe(200)
			expect(await response.text()).not.toContain('outside')
		}
		expect(root.protocol).toBe('http:')
	})

	it('lists no directory', async () => {
		const { url } = await serve('site/index.html')
		const dir = await fetch(new URL('img/', url))
		expect(dir.status).toBe(404)
		const folder = await fetch(new URL('./', url))
		expect(folder.status).toBe(200) // site/ has an index.html: that page, not a listing
		expect(await folder.text()).toContain('Hello')
	})

	it('answers only GET and HEAD, and only for its own Host', async () => {
		const { url } = await serve('site/index.html')
		expect((await fetch(url, { method: 'POST', body: 'x' })).status).toBe(405)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(200)
		const { request } = await import('node:http')
		const u = new URL(url)
		const status = await new Promise<number>((ok, fail) => {
			const req = request(
				{
					host: '127.0.0.1',
					port: Number(u.port),
					path: u.pathname,
					headers: { host: 'evil.example' },
				},
				(res) => {
					res.resume()
					res.on('end', () => ok(res.statusCode ?? 0))
				},
			)
			req.on('error', fail)
			req.end()
		})
		expect(status).toBe(403)
	})

	it('applies the read rules to what the page asks for, not only to the first file', async () => {
		const s = newServers()
		const target = await resolveLocalPage({ path: 'site/index.html' }, ctx())
		const url = await s.urlFor(target, '', (p) => p.endsWith('style.css'))
		expect((await fetch(url)).status).toBe(200)
		expect((await fetch(new URL('style.css', url))).status).toBe(403)
	})

	it('stops listening when closed, and a later page starts a new one', async () => {
		const { url, s } = await serve('site/index.html')
		expect(s.running).toBe(true)
		await s.close()
		expect(s.running).toBe(false)
		await expect(fetch(url)).rejects.toThrow()
		const target = await resolveLocalPage({ path: 'site/index.html' }, ctx())
		const again = await s.urlFor(target)
		expect((await fetch(again)).status).toBe(200)
		expect(new URL(again).port).not.toBe('')
	})
})

// ---------------------------------------------------------------------------
// Through the tool
// ---------------------------------------------------------------------------

interface Recording extends BrowserHost {
	readonly observed: BrowserObserveAction[]
}

function recordingHost(): Recording {
	const host: Recording = {
		id: 'fake-browser',
		capabilities: { engine: 'fake', headless: true, screenshot: true, upload: true },
		observed: [],
		async observe(action) {
			host.observed.push(action)
			return { page: { origin: 'null', url: 'about:blank', title: '', tab: 't1' } } as BrowserResult
		},
		async act(_action: BrowserActAction) {
			throw new Error('not used')
		},
	}
	return host
}

function manager(host: BrowserHost) {
	const [browser, act] = createBrowserTools(host)
	return new ToolManager({
		toolsets: [testToolset(browser as ToolDefinition, act as ToolDefinition)],
		messages: () => [],
	})
}

describe('the browser tool and a local page', () => {
	const urlOf = (host: Recording): string => {
		const last = host.observed.at(-1)
		if (!last || !('url' in last) || last.url === undefined) throw new Error('no url observed')
		return last.url
	}

	it.each([
		['a relative path', () => 'site/index.html'],
		['an absolute path', () => join(work, 'site', 'index.html')],
		['a file: URL', () => `file://${join(work, 'site', 'index.html')}`],
	])('opens a page by %s', async (_name, input) => {
		const host = recordingHost()
		const registry = manager(host)
		const result = await registry.execute('browser', { action: 'navigate', url: input() }, ctx())
		expect(result.success).toBe(true)
		const served = urlOf(host)
		expect(served).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/site\/index\.html$/)
		expect(await (await fetch(served)).text()).toContain('Hello')
		expect(await (await fetch(new URL('style.css', served))).text()).toContain('red')
		await closeBrowserLocalPages(host)
		await expect(fetch(served)).rejects.toThrow()
	})

	it('opens a page in a new tab by its path', async () => {
		const host = recordingHost()
		const registry = manager(host)
		await registry.execute('browser', { action: 'tabs', op: 'new', url: 'top.html' }, ctx())
		expect(urlOf(host)).toMatch(/\/top\.html$/)
		await closeBrowserLocalPages(host)
	})

	it('never hands the host a path or a file: address', async () => {
		const host = recordingHost()
		const registry = manager(host)
		for (const url of [
			'../outside/secret.html',
			join(outside, 'secret.html'),
			`file://${join(outside, 'secret.html')}`,
			'site/escape.html',
			'.git/config',
			'site/.env',
			'site/missing.html',
			'file://server/share/x.html',
		]) {
			const result = await registry.execute('browser', { action: 'navigate', url }, ctx())
			expect(result.success, url).toBe(false)
		}
		expect(host.observed).toEqual([])
	})

	it('names what is allowed in a refusal', async () => {
		const host = recordingHost()
		const result = await manager(host).execute(
			'browser',
			{ action: 'navigate', url: join(outside, 'secret.html') },
			ctx(),
		)
		expect(result.error).toMatch(/Local pages open from this session's work folder/)
	})

	it('still refuses a script address and still checks web addresses as before', async () => {
		const host = recordingHost()
		const registry = manager(host)
		const bad = registry.prepareExecution('browser', {
			action: 'navigate',
			url: 'javascript:alert(1)',
		})
		expect(bad.success).toBe(false)
		const meta = registry.prepareExecution('browser', {
			action: 'navigate',
			url: 'http://169.254.169.254/',
		})
		expect(meta.success).toBe(false)
		const web = await registry.execute(
			'browser',
			{ action: 'navigate', url: 'https://Example.com:443/a' },
			ctx(),
		)
		expect(web.success).toBe(true)
		expect(urlOf(host)).toBe('https://example.com/a')
	})
})
