import type { ConnectOverCDPTransport } from 'playwright-core'
import type { PaneChannel, PaneEvent } from './pane-channel.js'

/**
 * A transport that makes the tabs of a {@link PaneChannel} look like one
 * Chromium browser to `chromium.connectOverCDP`.
 *
 * Playwright expects a browser-level endpoint: it lists targets, attaches to
 * them, opens pages and contexts. A tab's debugger offers none of that, only
 * page-level commands. So the browser-level conversation is answered here
 * (target list, version, auto-attach, tab creation) and everything below a
 * page is forwarded to the channel by session id.
 *
 * Rules that were learned the hard way:
 *
 * - the fake target id must equal the real main-frame id, or the first
 *   navigation fails with "Frame has been detached";
 * - `Target.attachedToTarget` must be emitted before the reply to the
 *   `Target.setAutoAttach` that asked for it, or `pages()` is empty;
 * - a child session (iframe, worker) belongs to the tab whose event announced
 *   it, and its commands carry the child's session id; the tab's own session
 *   maps to none;
 * - the channel owns tabs: `Target.createTarget` is answered by the channel's
 *   `openTab`, and no browser-level method that could reach outside the pane
 *   (new contexts, closing the browser, storage) is answered at all.
 */

/** Browser-level session ids the shim hands out. */
const BROWSER_SESSION = 'PANE-B'
const TAB_SESSION = 'PANE-S'
const ALIAS_SESSION = 'PANE-A'
const CONTEXT_ID = 'PANE-CTX'
const BROWSER_TARGET = 'PANE-BROWSER'

interface Message {
	id?: number
	method?: string
	params?: Record<string, unknown>
	sessionId?: string
	result?: unknown
	error?: { code: number; message: string }
}

interface Target {
	readonly tabId: string
	readonly targetId: string
	readonly sid: string
	url: string
	title: string
	announced: boolean
	/** Waiting for the agent's first `Runtime.runIfWaitingForDebugger`. */
	paused: boolean
}

export interface PaneTransportOptions {
	/**
	 * Refuse a command before it reaches the channel. Returns the reason, or
	 * undefined to let it through. Default: {@link refuseOutsideThePane}.
	 */
	readonly refuse?: (
		method: string,
		params: Record<string, unknown> | undefined,
	) => string | undefined
}

export interface PaneTransport extends ConnectOverCDPTransport {
	/** The tabs the shim knows now, for tests and diagnostics. */
	targets(): readonly { tabId: string; targetId: string }[]
}

/**
 * Commands a page may issue that reach beyond the page the agent was given:
 * cookies and storage of the whole profile, debugger and tracing, a changed
 * user agent, and a download location. The agent has no use for them and the
 * host never sends them; a page-level debugger would answer all of them.
 */
export function refuseOutsideThePane(
	method: string,
	params: Record<string, unknown> | undefined,
): string | undefined {
	if (
		method.startsWith('Storage.') ||
		method.startsWith('IndexedDB.') ||
		method.startsWith('Debugger.') ||
		method.startsWith('Tracing.') ||
		method.startsWith('SystemInfo.') ||
		method.startsWith('Browser.') ||
		method === 'Network.getCookies' ||
		method === 'Network.getAllCookies' ||
		method === 'Network.setCookie' ||
		method === 'Network.setCookies' ||
		method === 'Network.deleteCookies' ||
		method === 'Network.clearBrowserCookies' ||
		method === 'Network.clearBrowserCache' ||
		method === 'Page.setDownloadBehavior' ||
		method === 'Security.setIgnoreCertificateErrors'
	) {
		// `Browser.getWindowForTarget` and friends are the page's own window, not the browser.
		if (method === 'Browser.getWindowForTarget' || method === 'Browser.setWindowBounds')
			return undefined
		return `${method} is not available in the browser pane`
	}
	if (method === 'Emulation.setUserAgentOverride') {
		const agent = params?.userAgent
		if (typeof agent === 'string' && agent !== '')
			return `${method} is not available in the browser pane`
	}
	return undefined
}

export function createPaneTransport(
	channel: PaneChannel,
	options: PaneTransportOptions = {},
): PaneTransport {
	const refuse = options.refuse ?? refuseOutsideThePane
	const targets = new Map<string, Target>() // by tabId
	const registering = new Map<string, Promise<Target | undefined>>()
	const owner = new Map<string, Target>() // session id -> tab
	const aliases = new Set<string>()
	let autoAttach = false
	let counter = 0
	let closed = false
	let initial: Promise<void> | undefined

	const transport: PaneTransport = {
		send: (message) => void dispatch(message as Message),
		close: () => shutdown(),
		targets: () => [...targets.values()].map((t) => ({ tabId: t.tabId, targetId: t.targetId })),
	}

	const emit = (message: Message): void => {
		queueMicrotask(() => {
			if (!closed) transport.onmessage?.(message)
		})
	}
	const info = (t: Target) => ({
		targetId: t.targetId,
		type: 'page',
		title: t.title,
		url: t.url,
		attached: true,
		canAccessOpener: false,
		browserContextId: CONTEXT_ID,
	})
	const answer = (m: Message, result: unknown): void => {
		emit({ id: m.id, sessionId: m.sessionId, result })
	}
	const fail = (m: Message, why: string): void => {
		emit({ id: m.id, sessionId: m.sessionId, error: { code: -32601, message: why } })
	}
	const announce = (t: Target): void => {
		t.announced = true
		emit({
			method: 'Target.attachedToTarget',
			params: { sessionId: t.sid, targetInfo: info(t), waitingForDebugger: t.paused },
		})
	}

	// A tab becomes a target once its real main-frame id is known.
	const register = (tabId: string, paused = false): Promise<Target | undefined> => {
		const known = targets.get(tabId)
		if (known) return Promise.resolve(known)
		const pending = registering.get(tabId)
		if (pending) return pending
		const promise = (async () => {
			// Let the map entry be set before the body can settle, however the channel fails.
			await Promise.resolve()
			try {
				const reply = (await channel.cdp(tabId, 'Target.getTargetInfo')) as {
					targetInfo: { targetId: string; url?: string; title?: string }
				}
				if (closed) return undefined
				counter += 1
				const t: Target = {
					tabId,
					targetId: reply.targetInfo.targetId,
					sid: `${TAB_SESSION}${counter}`,
					url: reply.targetInfo.url ?? '',
					title: reply.targetInfo.title ?? '',
					announced: false,
					paused,
				}
				targets.set(tabId, t)
				owner.set(t.sid, t)
				if (autoAttach) announce(t)
				return t
			} catch {
				// The tab closed, or its debugger is held by someone else. It is not the agent's.
				return undefined
			} finally {
				registering.delete(tabId)
			}
		})()
		registering.set(tabId, promise)
		return promise
	}

	const forget = (tabId: string): void => {
		const t = targets.get(tabId)
		if (!t) return
		targets.delete(tabId)
		for (const [sid, o] of [...owner]) {
			if (o === t) {
				owner.delete(sid)
				aliases.delete(sid)
			}
		}
		if (t.announced) {
			emit({
				method: 'Target.detachedFromTarget',
				params: { sessionId: t.sid, targetId: t.targetId },
			})
		}
	}

	const onEvent = (event: PaneEvent): void => {
		const t = targets.get(event.tabId)
		if (!t?.announced) return
		if (event.method === 'Target.detachedFromTarget') {
			// A child that detached is gone: a command naming it fails at once as unknown.
			const child = (event.params as { sessionId?: string } | undefined)?.sessionId
			if (child !== undefined && child !== t.sid) owner.delete(child)
		} else if (event.sessionId) owner.set(event.sessionId, t)
		emit({
			method: event.method,
			params: event.params as Record<string, unknown>,
			sessionId: event.sessionId ?? t.sid,
		})
	}

	const unsubscribe = [
		channel.onEvent(onEvent),
		channel.onTabAdded((tab) => void register(tab.tabId, tab.paused === true)),
		channel.onTabClosed(forget),
		channel.onClose((reason) => {
			if (closed) return
			closed = true
			unsubscribeAll()
			transport.onclose?.(reason ?? 'The browser pane closed.')
		}),
	]
	function unsubscribeAll(): void {
		for (const off of unsubscribe) off?.()
	}
	function shutdown(): void {
		if (closed) return
		closed = true
		unsubscribeAll()
		targets.clear()
		owner.clear()
		// Playwright waits for the close to be reported before it lets go of the connection.
		transport.onclose?.()
	}

	const firstTarget = (): Target | undefined => targets.values().next().value

	async function startup(): Promise<void> {
		initial ??= (async () => {
			const tabs = await channel.listTabs()
			await Promise.all(tabs.map((tab) => register(tab.tabId)))
		})()
		await initial
	}

	async function browserLevel(m: Message): Promise<void> {
		switch (m.method) {
			case 'Browser.getVersion': {
				let userAgent = 'Mozilla/5.0 Chrome/0.0.0.0'
				let product = 'Chrome/0.0.0.0'
				let revision = '0'
				const t = firstTarget()
				if (t) {
					try {
						const v = (await channel.cdp(t.tabId, 'Browser.getVersion')) as {
							userAgent?: string
							product?: string
							revision?: string
						}
						userAgent = v.userAgent ?? userAgent
						product = v.product ?? product
						revision = v.revision ?? revision
					} catch {
						// A page-level debugger may not answer; the defaults are enough to connect.
					}
				}
				return answer(m, { protocolVersion: '1.3', product, revision, userAgent, jsVersion: '0' })
			}
			case 'Target.setAutoAttach': {
				await startup()
				const was = autoAttach
				autoAttach = true
				// Announce before the reply, or Playwright's page list is empty.
				if (!was) for (const t of targets.values()) announce(t)
				return answer(m, {})
			}
			case 'Target.getTargetInfo':
				// The browser itself, asked on the root session. It has no page behind it, so the
				// answer is the same whether or not a tab is open.
				return answer(m, {
					targetInfo: {
						targetId: BROWSER_TARGET,
						type: 'browser',
						title: '',
						url: '',
						attached: true,
						canAccessOpener: false,
					},
				})
			case 'Target.getTargets': {
				await startup()
				return answer(m, { targetInfos: [...targets.values()].map(info) })
			}
			case 'Target.getBrowserContexts':
				return answer(m, { browserContextIds: [CONTEXT_ID] })
			case 'Target.setDiscoverTargets':
			case 'Browser.setDownloadBehavior':
				return answer(m, {})
			case 'Target.attachToBrowserTarget':
				counter += 1
				return answer(m, { sessionId: `${BROWSER_SESSION}${counter}` })
			case 'Target.attachToTarget': {
				const t = [...targets.values()].find((x) => x.targetId === m.params?.targetId)
				if (!t) return fail(m, 'No such tab in the browser pane.')
				counter += 1
				const sid = `${ALIAS_SESSION}${counter}`
				owner.set(sid, t)
				aliases.add(sid)
				return answer(m, { sessionId: sid })
			}
			case 'Target.detachFromTarget':
				return answer(m, {})
			case 'Target.createTarget': {
				if (!channel.openTab) {
					return fail(
						m,
						'The browser pane does not let the agent open tabs. Use the tab that is already open.',
					)
				}
				const url =
					typeof m.params?.url === 'string' && m.params.url !== 'about:blank'
						? m.params.url
						: undefined
				const tab = await channel.openTab(url)
				const t = await register(tab.tabId, tab.paused === true)
				if (!t) return fail(m, 'The browser pane opened a tab the agent cannot drive.')
				if (!t.announced) announce(t)
				return answer(m, { targetId: t.targetId })
			}
			case 'Target.closeTarget': {
				const t = [...targets.values()].find((x) => x.targetId === m.params?.targetId)
				if (!t) return fail(m, 'No such tab in the browser pane.')
				if (!channel.closeTab) return fail(m, 'The browser pane does not let the agent close tabs.')
				await channel.closeTab(t.tabId)
				return answer(m, { success: true })
			}
			default:
				// createBrowserContext, Browser.close, Storage.*: nothing outside the pane's tabs.
				return fail(m, `refused by the browser pane: ${m.method}`)
		}
	}

	async function dispatch(m: Message): Promise<void> {
		if (closed || m.method === undefined) return
		try {
			if (!m.sessionId || m.sessionId.startsWith(BROWSER_SESSION)) return await browserLevel(m)
			const t = owner.get(m.sessionId)
			if (!t) return fail(m, 'unknown session')
			if (m.method === 'Target.detachFromTarget') return answer(m, {})
			if (m.method === 'Runtime.runIfWaitingForDebugger') t.paused = false
			const why = refuse(m.method, m.params)
			if (why !== undefined) return fail(m, why)
			// The tab's own session, and an alias of it, map to none; a child session is named.
			const own = m.sessionId === t.sid || aliases.has(m.sessionId)
			const result = await channel.cdp(
				t.tabId,
				m.method,
				m.params ?? {},
				own ? undefined : m.sessionId,
			)
			answer(m, result ?? {})
		} catch (error) {
			emit({
				id: m.id,
				sessionId: m.sessionId,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			})
		}
	}

	return transport
}
