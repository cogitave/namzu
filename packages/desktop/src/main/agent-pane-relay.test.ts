import { EventEmitter } from 'node:events'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_BROWSER_TABS, MAX_BROWSER_TABS } from '../shared/browser-pane.js'
import type { BrowserCookieScope } from '../shared/settings-protocol.js'
import {
	AgentPaneRelay,
	type DebuggerLike,
	MAX_RESULT_BYTES,
	type RelayError,
	type RelayEvent,
	eventAllowed,
	screenAddress,
	screenMethod,
} from './agent-pane-relay.js'
import { siteAllowed } from './browser-address.js'
import {
	AGENT_PERSISTENT_PARTITION,
	BrowserPaneHost,
	agentPartitionOf,
	partitionOf,
} from './browser-pane.js'

type Handler = (details: { url: string }) => { url: string } | undefined

class FakeDebugger extends EventEmitter implements DebuggerLike {
	attached = false
	/** Another client already holds the page. */
	held = false
	calls: { method: string; params: unknown; sessionId?: string }[] = []
	answers = new Map<string, (params: unknown) => unknown>()
	attach() {
		if (this.held || this.attached) throw new Error('Another debugger is already attached')
		this.attached = true
	}
	detach() {
		this.attached = false
	}
	isAttached() {
		return this.attached
	}
	async sendCommand(method: string, params?: object, sessionId?: string) {
		this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
		const answer = this.answers.get(method)
		if (answer) return answer(params)
		if (method === 'Target.getTargetInfo')
			return { targetInfo: { targetId: `T-${this.calls.length}` } }
		return {}
	}
	message(method: string, params: unknown, sessionId?: string) {
		this.emit('message', {}, method, params, sessionId ?? '')
	}
}

interface FakePage {
	id: number
	partition: string
	dbg: FakeDebugger
	loaded: string[]
	view?: unknown
	visible: boolean
	inWindow: boolean
	throttling: boolean
	closed: boolean
	openHandler?: (details: { url: string }) => unknown
}

function setup(workFolders: Record<string, string> = { a: '/work/a', b: '/work/b' }) {
	let scope: BrowserCookieScope = 'quit'
	let next = 1
	const pages: FakePage[] = []
	const children = new Set<unknown>()
	const host = new BrowserPaneHost({
		window: {
			isDestroyed: () => false,
			contentView: {
				addChildView: (view: unknown) => {
					children.add(view)
					for (const page of pages) if (view === page.view) page.inWindow = true
				},
				removeChildView: (view: unknown) => {
					children.delete(view)
					for (const page of pages) if (view === page.view) page.inWindow = false
				},
			},
		} as unknown as BrowserWindow,
		createView: (partition) => {
			const page: FakePage = {
				id: next++,
				partition,
				dbg: new FakeDebugger(),
				loaded: [],
				visible: true,
				inWindow: false,
				throttling: true,
				closed: false,
			}
			const contents = {
				id: page.id,
				debugger: page.dbg,
				getURL: () => page.loaded.at(-1) ?? '',
				on: () => undefined,
				setWindowOpenHandler: (handler: FakePage['openHandler']) => {
					page.openHandler = handler
				},
				setBackgroundThrottling: (on: boolean) => {
					page.throttling = on
				},
				loadURL: (url: string) => {
					page.loaded.push(url)
					return Promise.resolve()
				},
				close: () => {
					page.closed = true
				},
				navigationHistory: { canGoBack: () => false, canGoForward: () => false },
			}
			const view = {
				webContents: contents,
				setVisible: (on: boolean) => {
					page.visible = on
				},
				setBounds: () => undefined,
			}
			page.view = view
			pages.push(page)
			return view as unknown as WebContentsView
		},
		sessionOf: () =>
			({
				setPermissionRequestHandler: () => undefined,
				setPermissionCheckHandler: () => undefined,
				setDevicePermissionHandler: () => undefined,
				on: () => undefined,
				webRequest: { onBeforeRequest: (_handler: Handler) => undefined },
			}) as unknown as Session,
		workFolder: (sessionId) => workFolders[sessionId],
		caseless: false,
		send: () => undefined,
		cookieScope: () => scope,
	})
	const shrink = vi.fn(async () => 'small')
	const relay = new AgentPaneRelay({
		shrinkImage: shrink,
		debuggerOf: (contents: WebContents) =>
			(contents as unknown as { debugger: DebuggerLike }).debugger,
	})
	relay.addHost(host)
	const events: RelayEvent[] = []
	relay.onEvent((event) => events.push(event))
	return {
		host,
		relay,
		pages,
		events,
		shrink,
		setScope: (value: BrowserCookieScope) => {
			scope = value
		},
	}
}

const ctx = {
	rules: { workFolder: '/work/a', caseless: false },
	sites: undefined,
	children: new Set<string>(),
	sessionId: undefined,
}

describe('the methods an agent may call', () => {
	const ok = (method: string, params?: Record<string, unknown>) =>
		screenMethod(method, params, ctx).ok
	it('opens the domains a driver needs and shuts the rest', () => {
		for (const method of [
			'Page.enable',
			'Page.captureScreenshot',
			'Runtime.evaluate',
			'DOM.getDocument',
			'Input.dispatchMouseEvent',
			'Emulation.setDeviceMetricsOverride',
			'Log.enable',
			'Accessibility.getFullAXTree',
			'Network.enable',
			'Network.setCacheDisabled',
			'Fetch.enable',
			'Fetch.continueRequest',
			'Target.setAutoAttach',
			'Browser.getVersion',
		])
			expect(ok(method), method).toBe(true)
		for (const method of [
			'Browser.close',
			'Browser.setDownloadBehavior',
			'Browser.getBrowserContexts',
			'Storage.getCookies',
			'Storage.clearDataForOrigin',
			'Network.getCookies',
			'Network.getAllCookies',
			'Network.setCookie',
			'Network.setCookies',
			'Network.deleteCookies',
			'Network.clearBrowserCookies',
			'Network.clearBrowserCache',
			'Network.loadNetworkResource',
			'Network.setUserAgentOverride',
			'IndexedDB.requestData',
			'DOMStorage.getDOMStorageItems',
			'Debugger.enable',
			'Tracing.start',
			'SystemInfo.getInfo',
			'Security.setIgnoreCertificateErrors',
			'Page.setDownloadBehavior',
			'Page.close',
			'Page.crash',
			'Emulation.setUserAgentOverride',
			'Target.createTarget',
			'Target.closeTarget',
			'Target.attachToTarget',
			'Target.setDiscoverTargets',
			'Fetch.takeResponseBodyAsStream',
			'IO.read',
			'DOM.getFileInfo',
			'Made.up',
		])
			expect(ok(method), method).toBe(false)
	})

	it('judges Page.navigate by the same rules as an address the person types, and sends the resolved one', () => {
		const navigate = (url: unknown) => screenMethod('Page.navigate', { url }, ctx)
		expect(navigate('https://example.com/a b')).toEqual({
			ok: true,
			params: { url: 'https://example.com/a%20b' },
		})
		expect(navigate('about:blank').ok).toBe(true)
		expect(navigate('file:///work/a/index.html').ok).toBe(true)
		// Dots are resolved before the folder is checked.
		expect(navigate('file:///work/a/../b/x.html')).toMatchObject({
			ok: false,
			code: 'address-refused',
		})
		expect(navigate('file:///etc/passwd')).toMatchObject({ ok: false, code: 'address-refused' })
		expect(navigate('file:///work/b/index.html').ok).toBe(false)
		for (const refused of [
			'javascript:alert(1)',
			'data:text/html,hi',
			'ftp://h/x',
			'example.com',
			'',
			5,
		])
			expect(navigate(refused).ok, String(refused)).toBe(false)
	})

	it('applies the site rules the engine passed, deny first', () => {
		const sites = { allow: ['example.com', '*.docs.test'], deny: ['bad.docs.test'] }
		expect(screenAddress('https://example.com/', ctx.rules, sites)).toBeDefined()
		expect(screenAddress('https://a.docs.test/', ctx.rules, sites)).toBeDefined()
		expect(screenAddress('https://bad.docs.test/', ctx.rules, sites)).toBeUndefined()
		expect(screenAddress('https://other.test/', ctx.rules, sites)).toBeUndefined()
		expect(siteAllowed('file:///work/a/x.html', sites)).toBe(true)
		expect(siteAllowed('https://anything.test/', undefined)).toBe(true)
		expect(siteAllowed('https://x.test/', { deny: ['*'] })).toBe(false)
	})

	it('judges a request sent on to another address, and a file given to a file field', () => {
		expect(screenMethod('Fetch.continueRequest', { requestId: '1' }, ctx).ok).toBe(true)
		expect(
			screenMethod('Fetch.continueRequest', { requestId: '1', url: 'file:///etc/passwd' }, ctx).ok,
		).toBe(false)
		const files = (list: unknown) => screenMethod('DOM.setFileInputFiles', { files: list }, ctx).ok
		expect(files(['/work/a/report.txt'])).toBe(true)
		expect(files(['/etc/passwd'])).toBe(false)
		expect(files(['/work/a/../../etc/passwd'])).toBe(false)
		expect(files(['relative.txt'])).toBe(false)
	})

	it('lets go of a child session only if the page announced it', () => {
		const detach = (id: string) =>
			screenMethod(
				'Target.detachFromTarget',
				{ sessionId: id },
				{ ...ctx, children: new Set(['S1']) },
			).ok
		expect(detach('S1')).toBe(true)
		expect(detach('S2')).toBe(false)
	})

	it('passes only the events a driver uses, and no cookie header', () => {
		for (const method of [
			'Page.frameNavigated',
			'Runtime.consoleAPICalled',
			'Network.responseReceived',
			'Target.attachedToTarget',
		])
			expect(eventAllowed(method), method).toBe(true)
		for (const method of [
			'Network.dataReceived',
			'Network.responseReceivedExtraInfo',
			'Network.requestWillBeSentExtraInfo',
			'Network.webSocketFrameReceived',
			'Debugger.paused',
			'Storage.cacheStorageUpdated',
		])
			expect(eventAllowed(method), method).toBe(false)
	})
})

describe('agent tabs in the pane', () => {
	it('count against a cap of their own and leave the person eight', () => {
		const pane = setup()
		for (let i = 0; i < MAX_BROWSER_TABS; i++) pane.host.handle('a', { kind: 'new' })
		expect(pane.host.handle('a', { kind: 'new' }).notice).toMatch(/Close a tab/)
		const first = pane.host.openAgentTab('a')
		expect(first.ok && first.reused).toBe(false)
		// A second open reuses the agent's tab instead of making another.
		const again = pane.host.openAgentTab('a')
		expect(again.ok && again.reused).toBe(true)
		const state = pane.host.handle('a', { kind: 'state' })
		expect(state.tabs.filter((tab) => tab.owner === 'agent')).toHaveLength(1)
		expect(state.tabs.filter((tab) => tab.owner === 'person')).toHaveLength(MAX_BROWSER_TABS)
		expect(state.tabs.find((tab) => tab.owner === 'agent')?.control).toBe('agent')
	})

	it('hold at most four agent tabs through popups, and refuse the fifth', async () => {
		const pane = setup()
		const opened = await pane.relay.open({ conversationId: 'a' })
		const opener = pane.pages[0] as FakePage
		for (let i = 1; i < MAX_AGENT_BROWSER_TABS; i++)
			opener.openHandler?.({ url: `http://127.0.0.1/${i}` })
		await Promise.resolve()
		expect(pane.host.agentTabs('a')).toHaveLength(MAX_AGENT_BROWSER_TABS)
		opener.openHandler?.({ url: 'http://127.0.0.1/5' })
		expect(pane.host.agentTabs('a')).toHaveLength(MAX_AGENT_BROWSER_TABS)
		expect(pane.host.handle('a', { kind: 'state' }).notice).toMatch(/tabs Namzu opened/)
		expect(opened.tabId).toBeTruthy()
	})

	it('live in a partition of their own, by the same setting as the person’s', () => {
		const pane = setup()
		pane.host.handle('a', { kind: 'new' })
		pane.host.openAgentTab('a')
		const [person, agent] = pane.pages
		expect(person?.partition).toBe(partitionOf('quit', 'a'))
		expect(agent?.partition).toBe(agentPartitionOf('quit', 'a'))
		expect(agent?.partition).not.toBe(person?.partition)
		expect(agentPartitionOf('restarts', 'a')).toBe(AGENT_PERSISTENT_PARTITION)
		expect(agentPartitionOf('restarts', 'a')).not.toBe(partitionOf('restarts', 'a'))
		expect(agentPartitionOf('conversation', 'a')).not.toBe(agentPartitionOf('conversation', 'b'))
		expect(agentPartitionOf('conversation', 'a')).not.toMatch(/^persist:/)
		expect(agentPartitionOf('quit', 'a')).not.toMatch(/^persist:/)
	})

	it('are hidden, never removed from the window, while nobody looks at them; and keep running', () => {
		const pane = setup()
		pane.host.openAgentTab('a')
		const agent = pane.pages[0] as FakePage
		expect(agent.inWindow).toBe(true)
		expect(agent.visible).toBe(false)
		expect(agent.throttling).toBe(false)
		pane.host.handle('a', { kind: 'place', bounds: { x: 0, y: 0, width: 800, height: 600 } })
		expect(agent.visible).toBe(true)
		pane.host.handle('a', { kind: 'place', bounds: null })
		expect(agent.visible).toBe(false)
		expect(agent.inWindow).toBe(true)
		pane.host.hide()
		expect(agent.inWindow).toBe(true)
	})

	it('are not taken by the person’s open-a-page request, and a tab of the person is not the agent’s', () => {
		const pane = setup()
		pane.host.openAgentTab('a')
		pane.host.handle('a', { kind: 'open', path: '/work/a/page.html' })
		const state = pane.host.handle('a', { kind: 'state' })
		const agentId = state.tabs.find((tab) => tab.owner === 'agent')?.id as string
		const personId = state.tabs.find((tab) => tab.owner === 'person')?.id as string
		expect((pane.pages[0] as FakePage).loaded).not.toContain('/work/a/page.html')
		expect(pane.host.agentTab('a', agentId)).toBeDefined()
		expect(pane.host.agentTab('a', personId)).toBeUndefined()
		expect(pane.host.agentTab('b', agentId)).toBeUndefined()
	})
})

describe('the relay', () => {
	const rejection = async (promise: Promise<unknown>) => {
		try {
			await promise
		} catch (error) {
			return error as RelayError
		}
		throw new Error('expected a refusal')
	}

	it('opens a tab, attaches the debugger once and returns the page’s own target', async () => {
		const pane = setup()
		const opened = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		expect(dbg.attached).toBe(true)
		expect(opened.targetInfo).toMatchObject({ targetId: expect.any(String) })
		const again = await pane.relay.open({ conversationId: 'a' })
		expect(again.tabId).toBe(opened.tabId)
		expect(pane.pages).toHaveLength(1)
	})

	it('sends a call to the page and returns what it answers', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		dbg.answers.set('Runtime.evaluate', () => ({ result: { value: 2 } }))
		await expect(
			pane.relay.cdp({
				conversationId: 'a',
				tabId,
				method: 'Runtime.evaluate',
				params: { expression: '1+1' },
			}),
		).resolves.toEqual({ result: { value: 2 } })
		await pane.relay.cdp({
			conversationId: 'a',
			tabId,
			method: 'Page.navigate',
			params: { url: 'http://127.0.0.1:1/x' },
		})
		expect(dbg.calls.at(-1)).toMatchObject({
			method: 'Page.navigate',
			params: { url: 'http://127.0.0.1:1/x' },
		})
	})

	it('never lets a refused method, or a file outside the work folder, reach the page', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		const before = dbg.calls.length
		expect(
			await rejection(
				pane.relay.cdp({ conversationId: 'a', tabId, method: 'Network.getAllCookies' }),
			),
		).toMatchObject({ code: 'method-refused' })
		expect(
			await rejection(pane.relay.cdp({ conversationId: 'a', tabId, method: 'Browser.close' })),
		).toMatchObject({ code: 'method-refused' })
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Page.navigate',
					params: { url: 'file:///etc/passwd' },
				}),
			),
		).toMatchObject({ code: 'address-refused' })
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Page.navigate',
					params: { url: 'file:///work/b/index.html' },
				}),
			),
		).toMatchObject({ code: 'address-refused' })
		expect(
			await rejection(pane.relay.cdp({ conversationId: 'a', tabId, method: 'not a method' })),
		).toMatchObject({ code: 'method-refused' })
		expect(dbg.calls.length).toBe(before)
	})

	it('binds navigations to the site rules given at open', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({
			conversationId: 'a',
			rules: { allow: ['127.0.0.1'] },
		})
		await pane.relay.cdp({
			conversationId: 'a',
			tabId,
			method: 'Page.navigate',
			params: { url: 'http://127.0.0.1:9/' },
		})
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Page.navigate',
					params: { url: 'https://example.com/' },
				}),
			),
		).toMatchObject({ code: 'address-refused' })
	})

	it('fails closed on another conversation’s tab, a tab of the person’s and an unknown id', async () => {
		const pane = setup()
		const mine = await pane.relay.open({ conversationId: 'a' })
		const theirs = await pane.relay.open({ conversationId: 'b' })
		pane.host.handle('a', { kind: 'new' })
		const person = pane.host
			.handle('a', { kind: 'state' })
			.tabs.find((tab) => tab.owner === 'person')?.id as string
		const call = (conversationId: string, tabId: string) =>
			pane.relay.cdp({
				conversationId,
				tabId,
				method: 'Runtime.evaluate',
				params: { expression: '1' },
			})
		expect(await rejection(call('a', theirs.tabId))).toMatchObject({ code: 'not-found' })
		expect(await rejection(call('b', mine.tabId))).toMatchObject({ code: 'not-found' })
		expect(await rejection(call('a', person))).toMatchObject({ code: 'not-found' })
		expect(await rejection(call('a', 'nope'))).toMatchObject({ code: 'not-found' })
		expect(await rejection(call('c', mine.tabId))).toMatchObject({ code: 'not-found' })
		// The person's tab never had a debugger.
		expect((pane.pages[2] as FakePage).dbg.calls).toEqual([])
		expect((pane.pages[0] as FakePage).dbg.calls.map((c) => c.method)).toEqual([
			'Target.getTargetInfo',
		])
	})

	it('owns the child sessions a page announces, and refuses one from anywhere else', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const other = await pane.relay.open({ conversationId: 'b' })
		const dbg = (pane.pages[0] as FakePage).dbg
		dbg.message('Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: {} })
		await pane.relay.cdp({
			conversationId: 'a',
			tabId,
			method: 'Runtime.enable',
			sessionId: 'CHILD',
		})
		expect(dbg.calls.at(-1)).toMatchObject({ method: 'Runtime.enable', sessionId: 'CHILD' })
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Runtime.enable',
					sessionId: 'GUESS',
				}),
			),
		).toMatchObject({ code: 'not-found' })
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'b',
					tabId: other.tabId,
					method: 'Runtime.enable',
					sessionId: 'CHILD',
				}),
			),
		).toMatchObject({ code: 'not-found' })
		dbg.message('Target.detachedFromTarget', { sessionId: 'CHILD' })
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Runtime.enable',
					sessionId: 'CHILD',
				}),
			),
		).toMatchObject({ code: 'not-found' })
	})

	it('reports a second client at attach time and removes the tab it could not drive', async () => {
		const pane = setup()
		const made = vi.spyOn(pane.host, 'openAgentTab').mockImplementation((sessionId, sites) => {
			const result = BrowserPaneHost.prototype.openAgentTab.call(pane.host, sessionId, sites)
			if (result.ok)
				(result.tab.contents as unknown as { debugger: FakeDebugger }).debugger.held = true
			return result
		})
		expect(await rejection(pane.relay.open({ conversationId: 'a' }))).toMatchObject({
			code: 'debugger-busy',
		})
		expect(pane.host.agentTabs('a')).toHaveLength(0)
		expect((pane.pages[0] as FakePage).closed).toBe(true)
		made.mockRestore()
	})

	it('refuses every call while the person has the tab, and resumes at hand-back', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const call = () =>
			pane.relay.cdp({
				conversationId: 'a',
				tabId,
				method: 'Runtime.evaluate',
				params: { expression: '1' },
			})
		expect(pane.relay.takeOver('a', tabId)).toBe(true)
		expect(await rejection(call())).toMatchObject({ code: 'human-in-control' })
		expect(pane.host.handle('a', { kind: 'state' }).tabs[0]?.control).toBe('person')
		expect(pane.events).toContainEqual({
			kind: 'state',
			conversationId: 'a',
			tabId,
			state: 'person',
		})
		expect(pane.relay.handBack('a', tabId)).toBe(true)
		await expect(call()).resolves.toEqual({})
		expect(pane.events).toContainEqual({
			kind: 'state',
			conversationId: 'a',
			tabId,
			state: 'agent',
		})
		expect(pane.relay.takeOver('b', tabId)).toBe(false)
	})

	it('reports a detach and then refuses calls until the tab is opened again', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		dbg.attached = false
		dbg.emit('detach', {}, 'target closed')
		expect(pane.events).toContainEqual({
			kind: 'detached',
			conversationId: 'a',
			tabId,
			reason: 'target closed',
		})
		expect(
			await rejection(pane.relay.cdp({ conversationId: 'a', tabId, method: 'Runtime.enable' })),
		).toMatchObject({ code: 'not-found' })
		const reopened = await pane.relay.open({ conversationId: 'a' })
		expect(reopened.tabId).toBe(tabId)
		expect(dbg.attached).toBe(true)
	})

	it('filters what the page says and strips cookie headers', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		dbg.message('Network.dataReceived', { dataLength: 5 })
		dbg.message('Network.responseReceivedExtraInfo', { headers: { 'set-cookie': 's=1' } })
		dbg.message('Debugger.paused', {})
		dbg.message('Page.frameNavigated', { frame: { id: 'F' } })
		dbg.message('Network.responseReceived', {
			response: { url: 'http://x/', headers: { 'Set-Cookie': 's=1', 'content-type': 'text/html' } },
		})
		dbg.message('Runtime.consoleAPICalled', { type: 'log' }, 'CHILD')
		expect(pane.events.map((event) => (event.kind === 'cdp' ? event.method : event.kind))).toEqual([
			'Page.frameNavigated',
			'Network.responseReceived',
			'Runtime.consoleAPICalled',
		])
		const network = pane.events[1]
		expect(network).toMatchObject({
			kind: 'cdp',
			tabId,
			params: { response: { headers: { 'content-type': 'text/html' } } },
		})
		expect(JSON.stringify(network)).not.toMatch(/set-cookie/i)
		expect(pane.events[2]).toMatchObject({ sessionId: 'CHILD' })
	})

	it('refuses an oversize request, shrinks an oversize screenshot and refuses any other oversize answer', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const dbg = (pane.pages[0] as FakePage).dbg
		const huge = 'x'.repeat(MAX_RESULT_BYTES + 10)
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'Runtime.evaluate',
					params: { expression: 'y'.repeat(1024 * 1024) },
				}),
			),
		).toMatchObject({ code: 'too-large' })
		dbg.answers.set('Page.captureScreenshot', () => ({ data: huge }))
		await expect(
			pane.relay.cdp({
				conversationId: 'a',
				tabId,
				method: 'Page.captureScreenshot',
				params: { format: 'png' },
			}),
		).resolves.toEqual({ data: 'small' })
		expect(pane.shrink).toHaveBeenCalledWith(huge, 'png', expect.any(Number))
		dbg.answers.set('DOM.getOuterHTML', () => ({ outerHTML: huge }))
		expect(
			await rejection(
				pane.relay.cdp({
					conversationId: 'a',
					tabId,
					method: 'DOM.getOuterHTML',
					params: { nodeId: 1 },
				}),
			),
		).toMatchObject({ code: 'too-large' })
	})

	it('announces a popup of the agent’s page as an agent tab, attached before its address loads', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		const opener = pane.pages[0] as FakePage
		expect(opener.openHandler?.({ url: 'http://127.0.0.1:9/popup' })).toEqual({ action: 'deny' })
		await vi.waitFor(() =>
			expect(pane.events.some((event) => event.kind === 'tab-added')).toBe(true),
		)
		const popup = pane.pages[1] as FakePage
		const added = pane.events.find((event) => event.kind === 'tab-added')
		expect(added).toMatchObject({ conversationId: 'a', openerTabId: tabId })
		expect(popup.dbg.attached).toBe(true)
		expect(pane.host.agentTabs('a')).toHaveLength(2)
		await vi.waitFor(() =>
			expect(popup.loaded).toEqual(['about:blank', 'http://127.0.0.1:9/popup']),
		)
		expect(
			pane.host.handle('a', { kind: 'state' }).tabs.filter((tab) => tab.owner === 'agent'),
		).toHaveLength(2)
	})

	it('turns a popup to a file outside the work folder away', async () => {
		const pane = setup()
		await pane.relay.open({ conversationId: 'a' })
		;(pane.pages[0] as FakePage).openHandler?.({ url: 'file:///etc/passwd' })
		expect(pane.pages).toHaveLength(1)
		expect(pane.host.handle('a', { kind: 'state' }).notice).toBeTruthy()
	})

	it('tells the engine when the person closes the tab, and detaches', async () => {
		const pane = setup()
		const { tabId } = await pane.relay.open({ conversationId: 'a' })
		pane.host.handle('a', { kind: 'close', tabId })
		expect(pane.events).toContainEqual({ kind: 'tab-closed', conversationId: 'a', tabId })
		expect((pane.pages[0] as FakePage).dbg.attached).toBe(false)
		expect(
			await rejection(pane.relay.cdp({ conversationId: 'a', tabId, method: 'Runtime.enable' })),
		).toMatchObject({ code: 'not-found' })
	})

	it('lets go on close, conversation end, engine restart, setting change and window close', async () => {
		const pane = setup()
		const a = await pane.relay.open({ conversationId: 'a' })
		const b = await pane.relay.open({ conversationId: 'b' })
		pane.relay.close({ conversationId: 'a', tabId: a.tabId })
		expect((pane.pages[0] as FakePage).dbg.attached).toBe(false)
		expect(pane.host.agentTabs('a')).toHaveLength(0)
		// Engine restart: detached, tab kept for the next open to reuse.
		pane.relay.releaseAll('engine-restarted', false)
		expect((pane.pages[1] as FakePage).dbg.attached).toBe(false)
		expect(pane.host.agentTabs('b')).toHaveLength(1)
		const again = await pane.relay.open({ conversationId: 'b' })
		expect(again.tabId).toBe(b.tabId)
		// A setting that changes the partition closes the tabs too.
		pane.relay.releaseAll('browser-cookies-changed', true)
		expect(pane.host.agentTabs('b')).toHaveLength(0)
		await pane.relay.open({ conversationId: 'a' })
		pane.relay.conversationEnded('a')
		expect(pane.host.agentTabs('a')).toHaveLength(0)
		await pane.relay.open({ conversationId: 'b' })
		const last = pane.pages.at(-1) as FakePage
		pane.host.dispose()
		expect(last.closed).toBe(true)
		expect(pane.events.at(-1)).toMatchObject({ kind: 'tab-closed', conversationId: 'b' })
	})

	it('gives up on a call the page never answers', async () => {
		vi.useFakeTimers()
		try {
			const pane = setup()
			const relay = new AgentPaneRelay({
				callMs: 1000,
				debuggerOf: (c: WebContents) => (c as unknown as { debugger: DebuggerLike }).debugger,
			})
			relay.addHost(pane.host)
			const { tabId } = await relay.open({ conversationId: 'a' })
			const dbg = (pane.pages.at(-1) as FakePage).dbg
			dbg.answers.set('Runtime.evaluate', () => new Promise(() => undefined))
			const pending = relay.cdp({
				conversationId: 'a',
				tabId,
				method: 'Runtime.evaluate',
				params: { expression: '1' },
			})
			const settled = pending.catch((error) => error)
			await vi.advanceTimersByTimeAsync(1000)
			expect(await settled).toMatchObject({ code: 'timeout' })
		} finally {
			vi.useRealTimers()
		}
	})
})

afterEach(() => {
	vi.useRealTimers()
})
