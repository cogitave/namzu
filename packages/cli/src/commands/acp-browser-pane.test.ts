import type { PaneEvent } from '@namzu/browser'
import { describe, expect, it } from 'vitest'
import {
	BROWSER_PANE_CAPABILITY,
	BROWSER_PANE_METHODS,
	BROWSER_PANE_SERVED_METHODS,
	type PaneConnection,
	createAcpPaneLink,
	paneSiteRules,
} from './acp-browser-pane.js'
import { desktopServerExtensions, handoffWindow } from './acp.js'

interface Call {
	method: string
	params: Record<string, unknown>
	answer(value: unknown): void
	fail(message: string): void
}

/** A connection that records each request and answers it when the test says so. */
function fakeConnection(offered = true) {
	const calls: Call[] = []
	const connection: PaneConnection = {
		offers: (capability) => offered && capability === BROWSER_PANE_CAPABILITY,
		ask: (method, params) =>
			new Promise((resolve, reject) => {
				calls.push({
					method,
					params,
					answer: resolve,
					fail: (message) => reject(new Error(message)),
				})
			}),
	}
	return { connection, calls }
}

const next = async (calls: Call[], count: number): Promise<void> => {
	while (calls.length < count) await Promise.resolve()
}

describe('the Browser pane link', () => {
	it('is available only to an app that named the capability', () => {
		expect(createAcpPaneLink(fakeConnection(true).connection).available()).toBe(true)
		expect(createAcpPaneLink(fakeConnection(false).connection).available()).toBe(false)
	})

	it('opens the conversation’s tab once, with the site rules, and lists it', async () => {
		const { connection, calls } = fakeConnection()
		const link = createAcpPaneLink(connection)
		const channel = link.channel('s1', { deny: ['bad.example'] })
		const first = channel.listTabs()
		const second = channel.listTabs()
		await next(calls, 1)
		expect(calls).toHaveLength(1)
		expect(calls[0]?.method).toBe(BROWSER_PANE_METHODS.open)
		expect(calls[0]?.params).toEqual({
			sessionId: 's1',
			rules: { deny: ['bad.example'] },
		})
		calls[0]?.answer({ tabId: 'tab-1', targetInfo: {} })
		expect(await first).toEqual([{ tabId: 'tab-1' }])
		expect(await second).toEqual([{ tabId: 'tab-1' }])
		expect(calls).toHaveLength(1)
	})

	it('sends no rules when there are none, and fails the open when the app names no tab', async () => {
		const { connection, calls } = fakeConnection()
		const channel = createAcpPaneLink(connection).channel('s1', {})
		const listing = channel.listTabs()
		await next(calls, 1)
		expect(calls[0]?.params).toEqual({ sessionId: 's1' })
		calls[0]?.answer({})
		await expect(listing).rejects.toThrow('did not name the tab')
	})

	it('carries a command with its child session, unwraps the result, and keeps the order', async () => {
		const { connection, calls } = fakeConnection()
		const channel = createAcpPaneLink(connection).channel('s1')
		const listing = channel.listTabs()
		await next(calls, 1)
		calls[0]?.answer({ tabId: 't' })
		await listing

		const a = channel.cdp('t', 'Page.enable')
		const b = channel.cdp('t', 'Runtime.evaluate', { expression: '1' }, 'child-9')
		await next(calls, 3)
		expect(calls.slice(1).map((call) => call.method)).toEqual([
			BROWSER_PANE_METHODS.cdp,
			BROWSER_PANE_METHODS.cdp,
		])
		expect(calls[1]?.params).toEqual({
			sessionId: 's1',
			tabId: 't',
			method: 'Page.enable',
		})
		expect(calls[2]?.params).toEqual({
			sessionId: 's1',
			tabId: 't',
			method: 'Runtime.evaluate',
			params: { expression: '1' },
			cdpSessionId: 'child-9',
		})
		// Answered out of order: each caller still gets its own answer.
		calls[2]?.answer({ result: { value: 2 } })
		calls[1]?.answer({ result: {} })
		expect(await b).toEqual({ value: 2 })
		expect(await a).toEqual({})
	})

	it('rejects with the app’s own words, and refuses anything after the link closed', async () => {
		const { connection, calls } = fakeConnection()
		const link = createAcpPaneLink(connection)
		const channel = link.channel('s1')
		const failing = channel.cdp('t', 'Page.navigate', { url: 'x' })
		await next(calls, 1)
		calls[0]?.fail('The person has taken over this tab. Wait for them to hand it back.')
		await expect(failing).rejects.toThrow('taken over this tab')

		let reason: string | undefined
		channel.onClose((why) => {
			reason = why
		})
		link.close('The app went away.')
		expect(reason).toBe('The app went away.')
		await expect(channel.cdp('t', 'Page.enable')).rejects.toThrow('not connected')
		expect(link.available()).toBe(false)
		// Closing twice reports once.
		reason = undefined
		link.close('again')
		expect(reason).toBeUndefined()
	})

	it('routes the app’s events to the channel of that conversation, in the order they came', async () => {
		const { connection, calls } = fakeConnection()
		const link = createAcpPaneLink(connection)
		const mine = link.channel('s1')
		const other = link.channel('s2')
		const events: PaneEvent[] = []
		const added: string[] = []
		const closed: string[] = []
		mine.onEvent((event) => events.push(event))
		mine.onTabAdded((tab) => added.push(tab.tabId))
		mine.onTabClosed((tab) => closed.push(tab))
		const heardByOther: PaneEvent[] = []
		other.onEvent((event) => heardByOther.push(event))
		const listing = mine.listTabs()
		await next(calls, 1)
		calls[0]?.answer({ tabId: 't1' })
		await listing

		const event = link.extensions[BROWSER_PANE_METHODS.event]
		expect(event).toBeDefined()
		event?.({
			sessionId: 's1',
			kind: 'cdp',
			tabId: 't1',
			method: 'Page.loadEventFired',
			params: { n: 1 },
		})
		event?.({
			sessionId: 's1',
			kind: 'cdp',
			tabId: 't1',
			method: 'Runtime.consoleAPICalled',
			params: { n: 2 },
			cdpSessionId: 'child',
		})
		event?.({
			sessionId: 's1',
			kind: 'tab-added',
			tabId: 't2',
			openerTabId: 't1',
		})
		event?.({ sessionId: 's1', kind: 'tab-added', tabId: 't2' })
		event?.({ sessionId: 's1', kind: 'tab-closed', tabId: 't2' })
		event?.({
			sessionId: 's1',
			kind: 'detached',
			tabId: 't1',
			reason: 'target closed',
		})
		event?.({
			sessionId: 'unknown',
			kind: 'cdp',
			tabId: 't1',
			method: 'Page.enable',
		})
		event?.({ sessionId: 's1', kind: 'cdp', method: 'Page.enable' })

		expect(events).toEqual([
			{ tabId: 't1', method: 'Page.loadEventFired', params: { n: 1 } },
			{
				tabId: 't1',
				method: 'Runtime.consoleAPICalled',
				params: { n: 2 },
				sessionId: 'child',
			},
		])
		expect(added).toEqual(['t2'])
		expect(closed).toEqual(['t2', 't1'])
		expect(heardByOther).toEqual([])
	})

	it('records who holds the tab', () => {
		const link = createAcpPaneLink(fakeConnection().connection)
		const channel = link.channel('s1')
		expect(channel.control()).toBe('agent')
		link.extensions[BROWSER_PANE_METHODS.state]?.({
			sessionId: 's1',
			tabId: 't',
			state: 'person',
		})
		expect(channel.control()).toBe('person')
		link.extensions[BROWSER_PANE_METHODS.state]?.({
			sessionId: 's1',
			tabId: 't',
			state: 'agent',
		})
		expect(channel.control()).toBe('agent')
		link.extensions[BROWSER_PANE_METHODS.state]?.({
			sessionId: 's1',
			tabId: 't',
			state: 'bogus',
		})
		expect(channel.control()).toBe('agent')
	})

	it('keeps the first tab open, closes a popup, and lets go of everything on close', async () => {
		const { connection, calls } = fakeConnection()
		const channel = createAcpPaneLink(connection).channel('s1')
		const listing = channel.listTabs()
		await next(calls, 1)
		calls[0]?.answer({ tabId: 'first' })
		await listing
		await expect(channel.closeTab?.('first')).rejects.toThrow('keeps this conversation’s first tab')
		expect(calls).toHaveLength(1)

		const closing = channel.closeTab?.('popup')
		await next(calls, 2)
		expect(calls[1]?.method).toBe(BROWSER_PANE_METHODS.close)
		expect(calls[1]?.params).toEqual({ sessionId: 's1', tabId: 'popup' })
		calls[1]?.answer({})
		await closing

		const done = channel.close()
		await next(calls, 3)
		expect(calls[2]?.params).toEqual({ sessionId: 's1' })
		calls[2]?.answer({})
		await done
		// A channel that was never opened asks nothing when it closes.
		await createAcpPaneLink(connection).channel('s9').close()
		expect(calls).toHaveLength(3)
	})
})

describe('the site rules the app enforces under the engine’s own', () => {
	it('says nothing when only the default asks', () => {
		expect(paneSiteRules({ '*': 'ask' })).toEqual({})
		expect(paneSiteRules({ '*': 'ask', 'https://github.com': 'act' })).toEqual({})
	})

	it('names the hosts a deny closes, with wildcards, dropping the port', () => {
		expect(
			paneSiteRules({
				'*': 'ask',
				'https://bank.example': 'deny',
				'https://*.ads.example': 'deny',
				'http://localhost:8080': 'deny',
			}),
		).toEqual({ deny: ['bank.example', '*.ads.example', 'localhost'] })
	})

	it('allows only the listed hosts when the default is deny, and no host when none is listed', () => {
		expect(
			paneSiteRules({
				'*': 'deny',
				'https://docs.example': 'read',
				'https://x.example': 'ask',
			}),
		).toEqual({ allow: ['docs.example', 'x.example'] })
		expect(paneSiteRules({ '*': 'deny' })).toEqual({ deny: ['*'] })
	})

	it('gives up on a key it cannot say as a host, so the engine’s own browser enforces it', () => {
		expect(paneSiteRules({ '*': 'ask', 'https://[::1]': 'deny' })).toBeUndefined()
	})
})

describe('where a paused turn’s sign-in happens', () => {
	it('is the pane when the browser runs there', () => {
		expect(handoffWindow({ headless: false, where: 'pane' })).toBe('pane')
	})
	it('is not said while a pane-capable browser has not started here', () => {
		expect(handoffWindow({ headless: false, where: 'unknown', prefersPane: true })).toBeUndefined()
	})
	it('is the browser’s own window, or none, once it fell back or never tried the pane', () => {
		expect(handoffWindow({ headless: true, where: 'own', prefersPane: true })).toBe('none')
		expect(handoffWindow({ headless: false })).toBe('visible')
		expect(handoffWindow({ headless: true })).toBe('none')
	})
})

describe('the methods the engine serves for the app', () => {
	it('are always listed, and answer nothing without a pane link', () => {
		const table = desktopServerExtensions(
			{} as never,
			process.cwd(),
			{
				getSessionCwd: () => undefined,
				retrySession: async () => ({}) as never,
			},
			undefined,
			undefined,
			undefined,
			{},
		)
		for (const name of BROWSER_PANE_SERVED_METHODS) expect(table[name]?.({})).toBeNull()
	})
})
