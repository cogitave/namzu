import { describe, expect, it } from 'vitest'
import type { PaneChannel, PaneEvent, PaneTabRef } from '../pane-channel.js'
import { createPaneTransport, refuseOutsideThePane } from '../pane-transport.js'

/** A channel with scripted tabs. No browser: the transport's own logic only. */
function fakeChannel(
	tabs: readonly string[],
	options: {
		openTab?: boolean
		failFor?: readonly string[]
		syncThrowFor?: readonly string[]
		hang?: boolean
	} = {},
) {
	const calls: { tabId: string; method: string; params?: object; sessionId?: string }[] = []
	const events = new Set<(e: PaneEvent) => void>()
	const added = new Set<(t: PaneTabRef) => void>()
	const closed = new Set<(id: string) => void>()
	const closeListeners = new Set<(reason?: string) => void>()
	const syncThrow = new Set(options.syncThrowFor)
	const open = new Set(tabs)
	let opened = 0
	const run = async (tabId: string, method: string, params?: object, sessionId?: string) => {
		calls.push({ tabId, method, params, sessionId })
		if (options.failFor?.includes(tabId)) throw new Error('debugger is held')
		if (method === 'Target.getTargetInfo') {
			return {
				targetInfo: { targetId: `frame-${tabId}`, url: `http://x/${tabId}`, title: tabId },
			}
		}
		if (method === 'Browser.getVersion') throw new Error('not on a page session')
		return { ran: method }
	}
	const channel: PaneChannel = {
		listTabs: async () => [...open].map((tabId) => ({ tabId })),
		cdp: (tabId, method, params, sessionId) => {
			if (syncThrow.has(tabId)) throw new Error('relay handle closed')
			if (options.hang && method === 'Runtime.evaluate') return new Promise<never>(() => undefined)
			return run(tabId, method, params, sessionId)
		},
		onClose: (l) => {
			closeListeners.add(l)
			return () => closeListeners.delete(l)
		},
		onEvent: (l) => {
			events.add(l)
			return () => events.delete(l)
		},
		onTabAdded: (l) => {
			added.add(l)
			return () => added.delete(l)
		},
		onTabClosed: (l) => {
			closed.add(l)
			return () => closed.delete(l)
		},
		...(options.openTab
			? {
					openTab: async () => {
						opened += 1
						const tabId = `new${opened}`
						open.add(tabId)
						return { tabId }
					},
				}
			: {}),
		close: async () => undefined,
	}
	return {
		channel,
		calls,
		syncThrow,
		emitEvent: (e: PaneEvent) => {
			for (const l of events) l(e)
		},
		addTab: (tabId: string) => {
			open.add(tabId)
			for (const l of added) l({ tabId })
		},
		drop: (reason?: string) => {
			for (const l of closeListeners) l(reason)
		},
		closeTab: (tabId: string) => {
			open.delete(tabId)
			for (const l of closed) l(tabId)
		},
	}
}

interface Wire {
	id?: number
	method?: string
	params?: Record<string, unknown>
	sessionId?: string
	result?: Record<string, unknown>
	error?: { message: string }
}

/** Drives a transport like Playwright does: numbered requests, replies matched by id. */
function wire(transport: ReturnType<typeof createPaneTransport>) {
	const received: Wire[] = []
	const waiting = new Map<number, (m: Wire) => void>()
	let n = 0
	transport.onmessage = (m) => {
		const message = m as Wire
		received.push(message)
		if (message.id !== undefined) waiting.get(message.id)?.(message)
	}
	return {
		received,
		request(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Wire> {
			n += 1
			const id = n
			return new Promise((resolve) => {
				waiting.set(id, resolve)
				transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) })
			})
		},
	}
}

describe('createPaneTransport', () => {
	it('announces every tab before it answers setAutoAttach, with the real frame id as target id', async () => {
		const fake = fakeChannel(['a', 'b'])
		const transport = createPaneTransport(fake.channel)
		const w = wire(transport)
		const version = await w.request('Browser.getVersion')
		expect(version.result).toMatchObject({ protocolVersion: '1.3' })
		const reply = await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		expect(reply.error).toBeUndefined()
		const attached = w.received.filter((m) => m.method === 'Target.attachedToTarget')
		expect(attached.map((m) => (m.params?.targetInfo as { targetId: string }).targetId)).toEqual([
			'frame-a',
			'frame-b',
		])
		const replyAt = w.received.findIndex((m) => m.id !== undefined && m.result && m === reply)
		expect(w.received.indexOf(attached[1] as Wire)).toBeLessThan(replyAt)
	})

	it('forwards page commands by session and keeps child sessions apart', async () => {
		const fake = fakeChannel(['a'])
		const transport = createPaneTransport(fake.channel)
		const w = wire(transport)
		await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		const sid = String(
			(
				w.received.find((m) => m.method === 'Target.attachedToTarget')?.params as {
					sessionId: string
				}
			).sessionId,
		)
		await w.request('Page.enable', {}, sid)
		// A frame the page's debugger reports gets its own session; its commands name it.
		fake.emitEvent({
			tabId: 'a',
			method: 'Target.attachedToTarget',
			params: { sessionId: 'child-1' },
		})
		fake.emitEvent({
			tabId: 'a',
			method: 'Runtime.executionContextCreated',
			params: {},
			sessionId: 'child-1',
		})
		await w.request('Runtime.enable', {}, 'child-1')
		const page = fake.calls.find((c) => c.method === 'Page.enable')
		const child = fake.calls.find((c) => c.method === 'Runtime.enable')
		expect(page).toMatchObject({ tabId: 'a', sessionId: undefined })
		expect(child).toMatchObject({ tabId: 'a', sessionId: 'child-1' })
		const routed = w.received.find((m) => m.method === 'Runtime.executionContextCreated')
		expect(routed?.sessionId).toBe('child-1')
		const own = w.received.filter(
			(m) => m.method === 'Target.attachedToTarget' && m.sessionId === sid,
		)
		expect(own).toHaveLength(1)
	})

	it('maps Target.createTarget to the channel and refuses it when the pane does not offer tabs', async () => {
		const withOpen = fakeChannel([], { openTab: true })
		const t1 = createPaneTransport(withOpen.channel)
		const w1 = wire(t1)
		await w1.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		const created = await w1.request('Target.createTarget', { url: 'about:blank' })
		expect(created.result?.targetId).toBe('frame-new1')
		const order = w1.received.map((m) => m.method ?? `reply${m.id}`)
		expect(order.indexOf('Target.attachedToTarget')).toBeLessThan(order.indexOf('reply2'))
		// The app also reporting the same tab does not announce it twice.
		withOpen.addTab('new1')
		await w1.request('Browser.getVersion')
		expect(w1.received.filter((m) => m.method === 'Target.attachedToTarget')).toHaveLength(1)

		const without = fakeChannel([])
		const t2 = createPaneTransport(without.channel)
		const w2 = wire(t2)
		const refused = await w2.request('Target.createTarget', { url: 'about:blank' })
		expect(refused.error?.message).toMatch(/does not let the agent open tabs/)
	})

	it('announces a tab the app adds later, once auto-attach is on, and detaches a closed one', async () => {
		const fake = fakeChannel(['a'])
		const transport = createPaneTransport(fake.channel)
		const w = wire(transport)
		await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		fake.addTab('popup')
		await w.request('Target.getTargets')
		const infos = (await w.request('Target.getTargets')).result?.targetInfos as {
			targetId: string
		}[]
		expect(infos.map((i) => i.targetId)).toEqual(['frame-a', 'frame-popup'])
		expect(w.received.filter((m) => m.method === 'Target.attachedToTarget')).toHaveLength(2)
		fake.closeTab('popup')
		await w.request('Target.getTargets')
		const detached = w.received.filter((m) => m.method === 'Target.detachedFromTarget')
		expect(detached.map((m) => m.params?.targetId)).toEqual(['frame-popup'])
	})

	it('leaves out a tab whose debugger it cannot take', async () => {
		const fake = fakeChannel(['a', 'held'], { failFor: ['held'] })
		const w = wire(createPaneTransport(fake.channel))
		await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		const attached = w.received.filter((m) => m.method === 'Target.attachedToTarget')
		expect(attached).toHaveLength(1)
	})

	it('answers nothing that reaches outside the pane', async () => {
		const fake = fakeChannel(['a'])
		const w = wire(createPaneTransport(fake.channel))
		await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		for (const method of ['Target.createBrowserContext', 'Browser.close', 'Storage.getCookies']) {
			const reply = await w.request(method, {})
			expect(reply.error?.message, method).toMatch(/refused by the browser pane/)
		}
		const sid = String(
			(
				w.received.find((m) => m.method === 'Target.attachedToTarget')?.params as {
					sessionId: string
				}
			).sessionId,
		)
		const cookies = await w.request('Network.getAllCookies', {}, sid)
		expect(cookies.error?.message).toMatch(/not available in the browser pane/)
		expect(fake.calls.map((c) => c.method)).not.toContain('Network.getAllCookies')
	})

	it('reports the close to Playwright, and stops forwarding afterwards', async () => {
		const fake = fakeChannel(['a'])
		const transport = createPaneTransport(fake.channel)
		const w = wire(transport)
		await w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
		let closedWith: unknown = 'not called'
		transport.onclose = (reason) => {
			closedWith = reason
		}
		transport.close()
		expect(closedWith).toBeUndefined()
		const before = w.received.length
		fake.emitEvent({ tabId: 'a', method: 'Page.loadEventFired', params: {} })
		await Promise.resolve()
		expect(w.received.length).toBe(before)
	})
})

describe('a link that fails', () => {
	const attach = (w: ReturnType<typeof wire>) =>
		w.request('Target.setAutoAttach', { autoAttach: true, flatten: true })
	const sessionOf = (w: ReturnType<typeof wire>) =>
		String(
			(
				w.received.find((m) => m.method === 'Target.attachedToTarget')?.params as {
					sessionId: string
				}
			).sessionId,
		)

	it('reports the close to Playwright when the app goes away with a command still waiting', async () => {
		const fake = fakeChannel(['a'], { hang: true })
		const transport = createPaneTransport(fake.channel)
		const w = wire(transport)
		await attach(w)
		let closedWith: unknown = 'not called'
		transport.onclose = (reason) => {
			closedWith = reason
		}
		void w.request('Runtime.evaluate', { expression: '1' }, sessionOf(w))
		await Promise.resolve()
		fake.drop('the app exited')
		expect(closedWith).toBe('the app exited')
	})

	it('detaches a tab that closes with a command waiting on it', async () => {
		const fake = fakeChannel(['a'], { hang: true })
		const w = wire(createPaneTransport(fake.channel))
		await attach(w)
		void w.request('Runtime.evaluate', { expression: '1' }, sessionOf(w))
		fake.closeTab('a')
		await Promise.resolve()
		await Promise.resolve()
		expect(w.received.filter((m) => m.method === 'Target.detachedFromTarget')).toHaveLength(1)
	})

	it('registers a tab again after a channel that threw synchronously', async () => {
		const fake = fakeChannel([], { syncThrowFor: ['b'] })
		const w = wire(createPaneTransport(fake.channel))
		await attach(w)
		fake.addTab('b')
		await w.request('Target.getTargets')
		expect(((await w.request('Target.getTargets')).result?.targetInfos as unknown[]).length).toBe(0)
		fake.syncThrow.delete('b')
		fake.addTab('b')
		await w.request('Target.getTargets')
		expect(((await w.request('Target.getTargets')).result?.targetInfos as unknown[]).length).toBe(1)
	})

	it('forgets a child session once it detaches', async () => {
		const fake = fakeChannel(['a'])
		const w = wire(createPaneTransport(fake.channel))
		await attach(w)
		fake.emitEvent({ tabId: 'a', method: 'Page.frameNavigated', params: {}, sessionId: 'child1' })
		expect((await w.request('Runtime.enable', {}, 'child1')).error).toBeUndefined()
		fake.emitEvent({
			tabId: 'a',
			method: 'Target.detachedFromTarget',
			params: { sessionId: 'child1' },
		})
		const after = await w.request('Runtime.enable', {}, 'child1')
		expect(after.error?.message).toBe('unknown session')
	})
})

describe('refuseOutsideThePane', () => {
	it('lets a page do page things and refuses the profile-wide ones', () => {
		for (const method of [
			'Page.navigate',
			'Runtime.evaluate',
			'Fetch.enable',
			'Input.dispatchMouseEvent',
		]) {
			expect(refuseOutsideThePane(method, {}), method).toBeUndefined()
		}
		for (const method of [
			'Storage.getCookies',
			'Network.getCookies',
			'Network.setCookie',
			'Network.clearBrowserCookies',
			'Page.setDownloadBehavior',
			'Debugger.enable',
			'Tracing.start',
			'Security.setIgnoreCertificateErrors',
		]) {
			expect(refuseOutsideThePane(method, {}), method).toMatch(/not available/)
		}
		expect(
			refuseOutsideThePane('Emulation.setUserAgentOverride', { userAgent: '' }),
		).toBeUndefined()
		expect(refuseOutsideThePane('Emulation.setUserAgentOverride', { userAgent: 'x' })).toMatch(
			/not available/,
		)
	})
})
