import { describe, expect, it } from 'vitest'
import type { BridgeBackend } from './bridge.js'
import { contentPolicy, originOf, partitionOf, sha256 } from './policy.js'
import { ViewRegistry } from './registry.js'
import type { SessionLike } from './session.js'
import {
	ExtensionPages,
	type NativeView,
	type PageSpec,
	type ViewContents,
	type ViewHost,
} from './view.js'

/** Everything Electron does is behind these fakes; what is set on a page, and in what order, is what is proved. */

class FakeSession implements SessionLike {
	handlers: Record<string, (...a: never[]) => unknown> = {}
	before: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | undefined
	headers:
		| ((
				d: { responseHeaders?: Record<string, string[]> },
				cb: (r: { responseHeaders: Record<string, string[]> }) => void,
		  ) => void)
		| undefined
	scheme: ((r: { url: string }) => unknown) | undefined
	setPermissionRequestHandler(h: (...a: never[]) => void) {
		this.handlers.request = h
	}
	setPermissionCheckHandler(h: (...a: never[]) => boolean) {
		this.handlers.check = h
	}
	setDevicePermissionHandler(h: (...a: never[]) => boolean) {
		this.handlers.device = h
	}
	setDisplayMediaRequestHandler(h: (...a: never[]) => void) {
		this.handlers.display = h
	}
	webRequest = {
		onBeforeRequest: (h: FakeSession['before']) => {
			this.before = h
		},
		onHeadersReceived: (h: FakeSession['headers']) => {
			this.headers = h
		},
	}
	protocol = {
		handle: (_s: string, h: (r: { url: string }) => unknown) => {
			this.scheme = h
		},
	}
}

class FakeContents implements ViewContents {
	static next = 100
	readonly id = FakeContents.next++
	readonly mainFrame = { url: '' }
	loaded: string[] = []
	closed = false
	listeners = new Map<string, (e: { preventDefault(): void }, ...a: string[]) => void>()
	openHandler: (() => { action: 'deny' }) | undefined
	sent: unknown[][] = []
	webrtc: string[] = []
	setWebRTCIPHandlingPolicy(p: string) {
		this.webrtc.push(p)
	}
	setWindowOpenHandler(h: () => { action: 'deny' }) {
		this.openHandler = h
	}
	on(ev: string, h: (e: { preventDefault(): void }, ...a: string[]) => void) {
		this.listeners.set(ev, h)
	}
	async loadURL(url: string) {
		this.loaded.push(url)
		this.mainFrame.url = url
	}
	isDestroyed() {
		return this.closed
	}
	close() {
		this.closed = true
	}
	send(c: string, ...a: unknown[]) {
		this.sent.push([c, ...a])
	}
}

class FakeHost implements ViewHost {
	sessions = new Map<string, FakeSession>()
	created: {
		prefs: Record<string, unknown>
		view: NativeView & { contents: FakeContents; bounds?: unknown }
	}[] = []
	attached: NativeView[] = []
	detached: NativeView[] = []
	order: string[] = []
	createView(prefs: never) {
		this.order.push('create')
		const contents = new FakeContents()
		const view = {
			webContents: contents,
			contents,
			bounds: undefined as unknown,
			setBounds(b: unknown) {
				this.bounds = b
			},
		}
		this.created.push({ prefs: prefs as Record<string, unknown>, view })
		return view
	}
	sessionFor(p: string) {
		this.order.push(`session ${p}`)
		let s = this.sessions.get(p)
		if (!s) {
			s = new FakeSession()
			this.sessions.set(p, s)
		}
		return s
	}
	attachedTo: unknown[] = []
	detachedFrom: unknown[] = []
	attach(v: NativeView, owner?: unknown) {
		this.order.push('attach')
		this.attachedTo.push(owner)
		this.attached.push(v)
	}
	detach(v: NativeView, owner?: unknown) {
		this.detachedFrom.push(owner)
		this.detached.push(v)
	}
	makeResponse = (
		body: Buffer | null,
		init: { status: number; headers: Record<string, string> },
	) => ({ body, ...init })
}

const spec = (id: string, over: Partial<PageSpec> = {}): PageSpec => ({
	extensionId: id,
	pageId: 'today',
	entry: 'ui/pages/today.html',
	slot: 'settings',
	usesNetwork: false,
	hosts: [],
	allow: ['query:counts'],
	host: ['theme'],
	maxBytes: { 'query:counts': 1024 },
	...over,
})

function make(
	files: { dir: string; files: { path: string; sha256: string }[] } = { dir: '/v', files: [] },
) {
	const host = new FakeHost()
	const audits: [string, string, string][] = []
	const stopped: string[] = []
	const backends: string[] = []
	const pages = new ExtensionPages(host, {
		preload: '/app/extension-page-preload.cjs',
		now: () => 0,
		backend: (info): BridgeBackend => ({
			extension: async (m) => {
				backends.push(`${info.extensionId}:${m}`)
				return { from: info.extensionId }
			},
			theme: () => ({ dark: false }),
			locale: () => ({}),
			state: () => ({}),
			openNamzu: () => {},
		}),
		assetSource: () => ({
			fs: { realpath: (p) => p, isRegularFile: () => true, read: () => Buffer.from('x') },
			path: { join: (...p) => p.join('/'), sep: '/' },
		}),
		files: () => files,
		audit: (id, e, d) => void audits.push([id, e, d]),
		onStopped: (id, page, why) => void stopped.push(`${id}/${page}/${why}`),
	})
	return { host, pages, audits, stopped, backends }
}
const bounds = { x: 10.4, y: 20.6, width: 300, height: 400 }

describe('a page is its own view with its own session', () => {
	it("creates the view with the written-out preferences, the extension's own partition and the Namzu preload, and nothing else", async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const prefs = host.created[0]?.prefs
		expect(prefs).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			partition: partitionOf('com.example.a', 'today'),
			preload: '/app/extension-page-preload.cjs',
		})
		expect(String(prefs?.partition).startsWith('persist:')).toBe(false)
	})
	it("hardens the partition before the first load, loads from the extension's own origin, and rounds the bounds main is given", async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const o = host.order
		expect(o.indexOf(`session ${partitionOf('com.example.a', 'today')}`)).toBeLessThan(
			o.indexOf('create'),
		)
		const c = host.created[0]?.view
		expect(c?.contents.loaded).toEqual([`${originOf('com.example.a')}/ui/pages/today.html`])
		expect(c?.bounds).toEqual({ x: 10, y: 21, width: 300, height: 400 })
		expect(host.attached).toHaveLength(1)
	})
	it('two extensions are two partitions, two origins, two views', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		await pages.show(spec('com.example.b'), bounds)
		expect(host.sessions.size).toBe(2)
		expect(host.created.map((c) => c.prefs.partition)).toEqual([
			partitionOf('com.example.a', 'today'),
			partitionOf('com.example.b', 'today'),
		])
		expect(pages.registry.all().map((p) => p.origin)).toEqual([
			originOf('com.example.a'),
			originOf('com.example.b'),
		])
	})
	it('the same page is reused, not loaded twice', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		await pages.show(spec('com.example.a'), { ...bounds, width: 500 })
		expect(host.created).toHaveLength(1)
		expect(host.created[0]?.view.bounds).toMatchObject({ width: 500 })
	})
})

describe("the session: everything denied, only the page's own things let through", () => {
	it('denies every permission, device and screen request', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'today')) as FakeSession
		let allowed: boolean | undefined
		;(s.handlers.request as unknown as (...a: unknown[]) => void)({}, 'media', (ok: boolean) => {
			allowed = ok
		})
		expect(allowed).toBe(false)
		expect((s.handlers.check as unknown as () => boolean)()).toBe(false)
		expect((s.handlers.device as unknown as () => boolean)()).toBe(false)
		let display: unknown = 'unset'
		;(s.handlers.display as unknown as (...a: unknown[]) => void)({}, (r: unknown) => {
			display = r
		})
		expect(display).toEqual({})
	})
	it("cancels a request to another extension, to Namzu's own origin and to any host when the page has no network", async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'today')) as FakeSession
		const cancelled = (url: string) => {
			let cancel: boolean | undefined
			s.before?.({ url }, (r) => {
				cancel = r.cancel
			})
			return cancel
		}
		expect(cancelled(`${originOf('com.example.a')}/ui/x.js`)).toBe(false)
		expect(cancelled(`${originOf('com.example.b')}/ui/x.js`)).toBe(true)
		expect(cancelled('namzu://app/index.html')).toBe(true)
		expect(cancelled('https://example.com/')).toBe(true)
		expect(cancelled('file:///home/me/.namzu/keys.json')).toBe(true)
	})
	it('a page with the network may reach only the hosts declared for it', async () => {
		const { host, pages } = make()
		await pages.show(
			spec('com.example.a', { usesNetwork: true, hosts: ['pages.example.com'], allow: [] }),
			bounds,
		)
		const s = host.sessions.get(partitionOf('com.example.a', 'today')) as FakeSession
		const cancelled = (url: string) => {
			let cancel: boolean | undefined
			s.before?.({ url }, (r) => {
				cancel = r.cancel
			})
			return cancel
		}
		expect(cancelled('https://pages.example.com/data')).toBe(false)
		expect(cancelled('https://evil.example.com/data')).toBe(true)
		let h: Record<string, string[]> = {}
		s.headers?.({ responseHeaders: { 'content-security-policy': ['default-src *'] } }, (r) => {
			h = r.responseHeaders
		})
		expect(h['Content-Security-Policy']).toEqual([contentPolicy(['pages.example.com'])])
		expect(
			Object.keys(h).filter((k) => k.toLowerCase() === 'content-security-policy'),
		).toHaveLength(1)
	})
	it('adds the policy to every response and replaces a header the page tried to loosen', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'today')) as FakeSession
		let h: Record<string, string[]> = {}
		s.headers?.(
			{ responseHeaders: { 'Content-Security-Policy': ['default-src *'], 'x-own': ['1'] } },
			(r) => {
				h = r.responseHeaders
			},
		)
		expect(h['Content-Security-Policy']).toEqual([contentPolicy()])
		expect(h['x-own']).toEqual(['1'])
		expect(h['Permissions-Policy']?.[0]).toContain('camera=()')
	})
	it('serves a listed file, 404s the rest, and a file that changed closes the page and is audited', async () => {
		const body = Buffer.from('x')
		const { host, pages, audits, stopped } = make({
			dir: '/v',
			files: [
				{ path: 'ui/pages/today.html', sha256: sha256(body) },
				{ path: 'ui/pages/bad.js', sha256: '0'.repeat(64) },
			],
		})
		await pages.show(spec('com.example.a'), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'today')) as FakeSession
		const o = originOf('com.example.a')
		expect(s.scheme?.({ url: `${o}/ui/pages/today.html` })).toMatchObject({ status: 200 })
		expect(s.scheme?.({ url: `${o}/ui/pages/other.html` })).toMatchObject({ status: 404 })
		expect(s.scheme?.({ url: `${originOf('com.example.b')}/ui/pages/today.html` })).toMatchObject({
			status: 404,
		})
		expect(s.scheme?.({ url: `${o}/ui/pages/bad.js` })).toMatchObject({ status: 500 })
		expect(audits).toEqual([['com.example.a', 'ui-file-changed', 'ui/pages/bad.js']])
		expect(stopped).toEqual(['com.example.a/today/changed'])
		expect(pages.registry.has(host.created[0]?.view.contents.id ?? -1)).toBe(false)
	})
})

describe('navigation and windows', () => {
	it('a page cannot open a window, navigate away, attach a webview or download', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const c = host.created[0]?.view.contents as FakeContents
		expect(c.openHandler?.()).toEqual({ action: 'deny' })
		const prevented = (ev: string, url?: string) => {
			let p = false
			c.listeners.get(ev)?.(
				{
					preventDefault: () => {
						p = true
					},
				},
				...(url ? [url] : []),
			)
			return p
		}
		for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
			expect(prevented(ev, 'https://example.com/')).toBe(true)
			expect(prevented(ev, `${originOf('com.example.b')}/ui/x.html`)).toBe(true)
			expect(prevented(ev, `${originOf('com.example.a')}/ui/other.html`)).toBe(false)
		}
		expect(prevented('will-attach-webview')).toBe(true)
		expect(prevented('will-download')).toBe(true)
	})
	it('a crashed or hung page is closed and marked stopped, not reloaded in a loop', async () => {
		const { host, pages, stopped } = make()
		await pages.show(spec('com.example.a'), bounds)
		const c = host.created[0]?.view.contents as FakeContents
		c.listeners.get('render-process-gone')?.({ preventDefault() {} })
		c.listeners.get('unresponsive')?.({ preventDefault() {} })
		expect(stopped).toEqual(['com.example.a/today/crashed'])
		expect(c.closed).toBe(true)
		expect(host.detached).toHaveLength(1)
		expect(c.loaded).toHaveLength(1)
	})
})

describe("the sender check: a page cannot reach Namzu's storage or another extension", () => {
	it("a message from Namzu's own window, an unregistered view, a sub-frame or another origin is dropped and counted", async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		const c = host.created[0]?.view.contents as FakeContents
		const ok = { sender: { id: c.id, mainFrame: c.mainFrame }, senderFrame: c.mainFrame }
		const env = { v: 1, id: 1, m: 'query:counts', p: {} }
		expect(await pages.handleCall(ok, env, false)).toMatchObject({ ok: true })
		const before = pages.registry.dropped
		const mainWindow = {
			sender: { id: 1, mainFrame: { url: 'namzu://app/index.html' } },
			senderFrame: { url: 'namzu://app/index.html' },
		}
		expect(await pages.handleCall(mainWindow, env, false)).toBeUndefined()
		expect(
			await pages.handleCall(
				{ sender: ok.sender, senderFrame: { url: c.mainFrame.url } },
				env,
				false,
			),
		).toBeUndefined()
		expect(
			await pages.handleCall({ sender: ok.sender, senderFrame: null }, env, false),
		).toBeUndefined()
		c.mainFrame.url = `${originOf('com.example.b')}/ui/pages/today.html`
		expect(await pages.handleCall(ok, env, false)).toBeUndefined()
		expect(pages.registry.dropped).toBe(before + 4)
	})
	it('the extension a call goes to is the one registered for the sender, never one the message names', async () => {
		const { host, pages, backends } = make()
		await pages.show(spec('com.example.a'), bounds)
		await pages.show(spec('com.example.b'), bounds)
		const [ca, cb] = host.created.map((x) => x.view.contents)
		for (const c of [ca, cb] as FakeContents[])
			await pages.handleCall(
				{ sender: { id: c.id, mainFrame: c.mainFrame }, senderFrame: c.mainFrame },
				{
					v: 1,
					id: 1,
					m: 'query:counts',
					p: { extensionId: 'com.example.a', ext: 'com.example.a' },
				},
				false,
			)
		expect(backends).toEqual(['com.example.a:query:counts', 'com.example.b:query:counts'])
	})
	it('three strikes close the page, audit ui-closed and unregister the sender', async () => {
		const { host, pages, audits, stopped } = make()
		await pages.show(spec('com.example.a'), bounds)
		const c = host.created[0]?.view.contents as FakeContents
		const ev = { sender: { id: c.id, mainFrame: c.mainFrame }, senderFrame: c.mainFrame }
		for (let i = 0; i < 3; i++) await pages.handleCall(ev, { v: 9 }, false)
		expect(audits).toEqual([['com.example.a', 'ui-closed', 'strikes']])
		expect(stopped).toEqual(['com.example.a/today/strikes'])
		expect(await pages.handleCall(ev, { v: 1, id: 1, m: 'query:counts' }, false)).toBeUndefined()
	})
	it('closing an extension closes its pages and forgets them', async () => {
		const { host, pages } = make()
		await pages.show(spec('com.example.a'), bounds)
		pages.closeExtension('com.example.a')
		expect(pages.registry.all()).toEqual([])
		expect(host.detached).toHaveLength(1)
		await pages.show(spec('com.example.a'), bounds)
		expect(host.created).toHaveLength(2)
	})
	it('registry: a bare map lookup answers only what was registered', () => {
		const r = new ViewRegistry()
		r.register(5, { extensionId: 'a', pageId: 'p', origin: originOf('a') })
		expect(r.get(5)?.extensionId).toBe('a')
		expect(r.get(6)).toBeUndefined()
		r.unregister(5)
		expect(r.has(5)).toBe(false)
	})
})

describe('a close that arrives while the page is still being opened', () => {
	it('leaves no view behind: the late show creates and attaches nothing', async () => {
		const { host, pages } = make()
		const ticket = pages.ticket('com.example.a', 'today')
		// the renderer closed the page while the engine was still answering
		pages.close('com.example.a', 'today')
		expect(await pages.show(spec('com.example.a'), bounds, { ticket })).toBeUndefined()
		expect(host.created).toHaveLength(0)
		expect(host.attached).toHaveLength(0)
		// a show that took its ticket after the close (the remount) is let through
		const again = pages.ticket('com.example.a', 'today')
		expect(await pages.show(spec('com.example.a'), bounds, { ticket: again })).toBeDefined()
		expect(host.created).toHaveLength(1)
	})
	it('closing the whole extension cancels the pages that were still pending', async () => {
		const { host, pages } = make()
		const ticket = pages.ticket('com.example.a', 'today')
		pages.closeExtension('com.example.a')
		expect(await pages.show(spec('com.example.a'), bounds, { ticket })).toBeUndefined()
		expect(host.created).toHaveLength(0)
	})
})

describe('a slot that changes while the page is still being opened', () => {
	it('starts the view at the newest rectangle, not the first one the renderer sent', async () => {
		const { host, pages } = make()
		const ticket = pages.ticket('com.example.a', 'today')
		// the first rectangle was empty (a dialog lay over the slot); the dialog closed while the engine answered
		pages.setBounds('com.example.a', 'today', { x: 288, y: 64, width: 992, height: 769 })
		await pages.show(spec('com.example.a'), { x: 288, y: 64, width: 0, height: 0 }, { ticket })
		expect(host.created[0]?.view.bounds).toEqual({ x: 288, y: 64, width: 992, height: 769 })
	})
	it('does not carry a rectangle from an earlier opening into a later one', async () => {
		const { host, pages } = make()
		const first = pages.ticket('com.example.a', 'today')
		pages.setBounds('com.example.a', 'today', { x: 1, y: 2, width: 3, height: 4 })
		pages.close('com.example.a', 'today')
		expect(await pages.show(spec('com.example.a'), bounds, { ticket: first })).toBeUndefined()
		const again = pages.ticket('com.example.a', 'today')
		await pages.show(spec('com.example.a'), bounds, { ticket: again })
		expect(host.created[0]?.view.bounds).toEqual({ x: 10, y: 21, width: 300, height: 400 })
	})
})

describe('the rules of a page are its own, not those of another page of the extension', () => {
	const page = (id: string, over: Partial<PageSpec>) =>
		spec('com.example.a', {
			pageId: id,
			entry: `ui/pages/${id}.html`,
			...over,
		})
	const asks = (s: FakeSession, url: string): boolean => {
		let cancelled = true
		s.before?.({ url }, (r) => {
			cancelled = r.cancel
		})
		return !cancelled
	}
	it('a page with no network is not given the hosts of one that has', async () => {
		const { host, pages } = make()
		await pages.show(page('net', { usesNetwork: true, hosts: ['api.example.com'] }), bounds)
		await pages.show(page('quiet', { usesNetwork: false, hosts: [] }), bounds)
		const net = host.sessions.get(partitionOf('com.example.a', 'net')) as FakeSession
		const quiet = host.sessions.get(partitionOf('com.example.a', 'quiet')) as FakeSession
		expect(net).not.toBe(quiet)
		expect(asks(net, 'https://api.example.com/x')).toBe(true)
		expect(asks(quiet, 'https://api.example.com/x')).toBe(false)
		// and the other way round: opening the quiet one first changes nothing
		const second = make()
		await second.pages.show(page('quiet', { usesNetwork: false }), bounds)
		await second.pages.show(page('net', { usesNetwork: true, hosts: ['api.example.com'] }), bounds)
		const net2 = second.host.sessions.get(partitionOf('com.example.a', 'net')) as FakeSession
		expect(asks(net2, 'https://api.example.com/x')).toBe(true)
	})
	it('after an update that narrows the hosts, the old ones are refused at once', async () => {
		const { host, pages } = make()
		await pages.show(page('net', { usesNetwork: true, hosts: ['api.example.com'] }), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'net')) as FakeSession
		expect(asks(s, 'https://api.example.com/x')).toBe(true)
		pages.closeExtension('com.example.a')
		expect(asks(s, 'https://api.example.com/x')).toBe(false)
		await pages.show(page('net', { usesNetwork: false, hosts: [] }), bounds)
		// same session object, new rules
		expect(host.sessions.get(partitionOf('com.example.a', 'net'))).toBe(s)
		expect(asks(s, 'https://api.example.com/x')).toBe(false)
	})
	it('a file that changed after it was signed stops every open page of that extension', async () => {
		const { host, pages, stopped } = make()
		await pages.show(page('one', {}), bounds)
		await pages.show(page('two', {}), bounds)
		const s = host.sessions.get(partitionOf('com.example.a', 'one')) as FakeSession
		const r = s.scheme?.({
			url: `${originOf('com.example.a')}/ui/pages/one.html`,
		})
		expect(r).toBeDefined()
		pages.stopExtension('com.example.a', 'changed')
		expect(stopped.sort()).toEqual(['com.example.a/one/changed', 'com.example.a/two/changed'])
	})
	it('a page without a network is told to close WebRTC, and one with a network is not', async () => {
		const { host, pages } = make()
		await pages.show(page('quiet', { usesNetwork: false }), bounds)
		await pages.show(page('net', { usesNetwork: true, hosts: ['api.example.com'] }), bounds)
		expect(host.created.map((c) => c.prefs.additionalArguments)).toEqual([
			['--namzu-ext-no-network=1'],
			[],
		])
	})
	it('every view holds WebRTC to proxied traffic', async () => {
		const { host, pages } = make()
		await pages.show(page('one', {}), bounds)
		expect((host.created[0]?.view.contents as FakeContents).webrtc).toEqual([
			'disable_non_proxied_udp',
		])
	})
})

describe('a view lives as long as the window that opened it', () => {
	it('closing what one window owns detaches from that window and leaves the other window alone', async () => {
		const { host, pages } = make()
		const w1 = { name: 'w1' }
		const w2 = { name: 'w2' }
		await pages.show(spec('com.example.a', { pageId: 'one' }), bounds, {
			owner: w1,
		})
		await pages.show(spec('com.example.b', { pageId: 'two' }), bounds, {
			owner: w2,
		})
		const pending = pages.ticket('com.example.c', 'three', w1)
		expect(host.attachedTo).toEqual([w1, w2])
		pages.closeOwned(w1)
		expect(host.detachedFrom).toEqual([w1])
		expect(pages.all().map((p) => p.info.extensionId)).toEqual(['com.example.b'])
		// a page of that window still being opened is cancelled too
		expect(
			await pages.show(spec('com.example.c', { pageId: 'three' }), bounds, {
				ticket: pending,
				owner: w1,
			}),
		).toBeUndefined()
	})
})
