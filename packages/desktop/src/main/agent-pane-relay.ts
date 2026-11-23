import type { WebContents } from 'electron'
import type { BrowserTabControl } from '../shared/browser-pane.js'
import {
	type AddressRules,
	type SiteRules,
	cleanPath,
	isAbsolutePath,
	isInside,
	resolveAddress,
	siteAllowed,
} from './browser-address.js'
import type { AgentTabEvent, AgentTabHandle, BrowserPaneHost } from './browser-pane.js'

/**
 * The only door between an agent and the pages of the Browser pane.
 *
 * The engine drives a page with the browser protocol (CDP). Here it does so through the page's own
 * in-process debugger, never a debugging port: nothing in the app listens, and no `/json` address
 * exists. The relay attaches that debugger to a tab only when the tab is the agent's (opened for it
 * by `BrowserPaneHost`, in the conversation that asks) and refuses every other tab, so a page the
 * person opened, a tab of another conversation, the app's own window and a made-up id are all out of
 * reach. A call goes through four checks before it reaches the page, and none depends on the engine
 * being well behaved:
 *
 * 1. the tab and, if given, the child session belong to that conversation;
 * 2. the method is on the allowlist below, with the exceptions inside the allowed domains (cookies,
 *    storage, downloads, the user agent, files read by path) refused;
 * 3. an address a call would load (`Page.navigate`, a rewritten request) passes the same rules as
 *    an address the person types, plus the site rules the engine gave when it opened the tab, and
 *    the request has the shape and size the relay expects;
 * 4. the tab is not taken over by the person.
 *
 * The session's request filter in the host stays under all of this as a backstop. The relay never
 * records a call's parameters, which can hold what a person typed: only a method name and sizes
 * leave it, through `note`.
 */

/** The largest request and result, in bytes. A screenshot over the result limit is re-encoded first. */
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_RESULT_BYTES = 4 * 1024 * 1024
/** How many calls one conversation may have in flight at once. */
const MAX_IN_FLIGHT = 64
/** How long one call may take before it is given up on; a screenshot gets less. */
const CALL_MS = 60_000
const SCREENSHOT_MS = 30_000

export type RelayErrorCode =
	| 'unavailable'
	| 'not-found'
	| 'tab-cap'
	| 'human-in-control'
	| 'method-refused'
	| 'address-refused'
	| 'too-large'
	| 'debugger-busy'
	| 'detached'
	| 'busy'
	| 'timeout'
	| 'cdp-error'

/** What a refused or failed call says. `code` is for the engine; `message` is plain words. */
export class RelayError extends Error {
	constructor(
		readonly code: RelayErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'RelayError'
	}
}

/** What an agent tab's debugger offers; Electron's `webContents.debugger` is this. */
export interface DebuggerLike {
	attach(protocolVersion?: string): void
	detach(): void
	isAttached(): boolean
	sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
	on(event: 'message', listener: (...args: unknown[]) => void): unknown
	on(event: 'detach', listener: (...args: unknown[]) => void): unknown
	removeListener(event: 'message' | 'detach', listener: (...args: unknown[]) => void): unknown
}

export type RelayEvent =
	| {
			kind: 'cdp'
			conversationId: string
			tabId: string
			method: string
			params: unknown
			sessionId?: string
	  }
	| {
			kind: 'tab-added'
			conversationId: string
			tabId: string
			openerTabId?: string
			targetInfo: unknown
	  }
	| { kind: 'tab-closed'; conversationId: string; tabId: string }
	| { kind: 'detached'; conversationId: string; tabId: string; reason: string }
	| { kind: 'state'; conversationId: string; tabId: string; state: BrowserTabControl }

export interface AgentPaneRelayDeps {
	/** The window that should hold a conversation's first agent tab (the focused one). */
	preferredHost?: () => BrowserPaneHost | undefined
	/**
	 * Re-encodes a screenshot's base64 data to fit `maxChars` characters, or returns undefined when it
	 * cannot. Electron's image codec lives behind it so the relay has no Electron in it.
	 */
	shrinkImage?: (data: string, format: string, maxChars: number) => Promise<string | undefined>
	/** Method names and sizes only, for diagnostics. Never a parameter. */
	note?: (what: string, detail: { method?: string; bytes?: number; code?: string }) => void
	/** The debugger of a page; Electron's by default. */
	debuggerOf?: (contents: WebContents) => DebuggerLike
	callMs?: number
	screenshotMs?: number
}

interface Driven {
	conversationId: string
	host: BrowserPaneHost
	tab: AgentTabHandle
	dbg: DebuggerLike
	/** Child sessions (frames in other processes, workers) the page announced, by id. */
	children: Set<string>
	attached: boolean
	inFlight: number
	onMessage: (...args: unknown[]) => void
	onDetach: (...args: unknown[]) => void
}

// ---- What may be called -------------------------------------------------------------------------

/** Domains whose methods are all open, bar the exceptions in `REFUSED`. */
const OPEN_DOMAINS = new Set(['Runtime', 'DOM', 'Log', 'Accessibility', 'Emulation'])

/** Methods open in domains that are otherwise shut. Everything not here or above is refused. */
const OPEN_METHODS = new Set([
	'Browser.getVersion',
	// Input, method by method: a drag can carry files by path, so it is screened (see `screenMethod`).
	'Input.dispatchKeyEvent',
	'Input.dispatchMouseEvent',
	'Input.dispatchTouchEvent',
	'Input.dispatchDragEvent',
	'Input.insertText',
	'Input.imeSetComposition',
	'Input.emulateTouchFromMouseEvent',
	'Input.synthesizeScrollGesture',
	'Input.synthesizePinchGesture',
	'Input.synthesizeTapGesture',
	'Input.setIgnoreInputEvents',
	'Input.setInterceptDrags',
	'Input.cancelDragging',
	// The page itself: load, reload, history, scripts that run on each document, pictures, dialogs.
	'Page.enable',
	'Page.disable',
	'Page.navigate',
	'Page.reload',
	'Page.stopLoading',
	'Page.getFrameTree',
	'Page.getNavigationHistory',
	'Page.navigateToHistoryEntry',
	'Page.resetNavigationHistory',
	'Page.addScriptToEvaluateOnNewDocument',
	'Page.removeScriptToEvaluateOnNewDocument',
	'Page.setLifecycleEventsEnabled',
	'Page.createIsolatedWorld',
	'Page.bringToFront',
	'Page.captureScreenshot',
	'Page.printToPDF',
	'Page.setBypassCSP',
	'Page.setInterceptFileChooserDialog',
	'Page.handleJavaScriptDialog',
	'Page.setDocumentContent',
	'Page.getLayoutMetrics',
	'Page.startScreencast',
	'Page.stopScreencast',
	'Page.screencastFrameAck',
	// The network's request lifecycle. No cookie, no cache wipe, no loading a URL by itself.
	'Network.enable',
	'Network.disable',
	'Network.setCacheDisabled',
	'Network.setExtraHTTPHeaders',
	'Network.emulateNetworkConditions',
	'Network.setBypassServiceWorker',
	'Network.getResponseBody',
	// Interception. A stream of a body is not offered.
	'Fetch.enable',
	'Fetch.disable',
	'Fetch.continueRequest',
	'Fetch.fulfillRequest',
	'Fetch.failRequest',
	'Fetch.continueResponse',
	'Fetch.continueWithAuth',
	'Fetch.getResponseBody',
	// The child sessions of this page only; making or listing other targets belongs to the pane.
	'Target.setAutoAttach',
	'Target.getTargetInfo',
	'Target.detachFromTarget',
])

/** Refused even inside an open domain. */
const REFUSED = new Set([
	// The user agent says who is asking; the page is the person's own browser.
	'Emulation.setUserAgentOverride',
	// A file read by its path on the disk.
	'DOM.getFileInfo',
])

/** The network events the host reads. Body-by-body events and socket frames are dropped. */
const NETWORK_EVENTS = new Set([
	'Network.requestWillBeSent',
	'Network.responseReceived',
	'Network.loadingFinished',
	'Network.loadingFailed',
	'Network.requestServedFromCache',
])

const EVENT_DOMAINS = new Set(['Page', 'Runtime', 'Fetch', 'DOM', 'Input', 'Log', 'Accessibility'])
const TARGET_EVENTS = new Set([
	'Target.attachedToTarget',
	'Target.detachedFromTarget',
	'Target.targetCrashed',
])

export interface MethodContext {
	rules: AddressRules
	sites: SiteRules | undefined
	/** The session id the call names, already known to belong to the tab; undefined for the page's own. */
	children: ReadonlySet<string>
	sessionId: string | undefined
}

export type Screened =
	| { ok: true; params: Record<string, unknown> | undefined }
	| { ok: false; code: 'method-refused' | 'address-refused'; message: string }

const WORDS_METHOD = 'Namzu does not let a browser tab be used that way.'
const WORDS_ADDRESS = 'That address is not open to Namzu here.'

/**
 * An address a call would load, judged like one the person types plus the site rules. Only an
 * absolute address is accepted (a call is not a place for a bare host). Returns the address to load.
 */
export function screenAddress(
	url: unknown,
	rules: AddressRules,
	sites: SiteRules | undefined,
): string | undefined {
	if (typeof url !== 'string') return undefined
	if (url === 'about:blank') return url
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return undefined
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:')
		return undefined
	const found = resolveAddress(url, rules)
	if (!found.ok || !siteAllowed(found.url, sites)) return undefined
	return found.url
}

/** Whether every file named is an absolute path inside the work folder. An empty list names none. */
function filesInside(files: unknown, rules: AddressRules, required: boolean): boolean {
	if (files === undefined) return !required
	if (!Array.isArray(files)) return false
	if (files.length === 0) return true
	const root = rules.workFolder
	return (
		root !== undefined &&
		files.every(
			(file) =>
				typeof file === 'string' &&
				isAbsolutePath(file) &&
				isInside(root, cleanPath(file), rules.caseless),
		)
	)
}

/**
 * Whether a call may go to the page, and with what parameters. Pure: no page, no Electron, so every
 * row of the policy has a test. A call that carries an address is returned with the address the
 * rules resolved, not the one asked for.
 */
export function screenMethod(
	method: string,
	params: Record<string, unknown> | undefined,
	context: MethodContext,
): Screened {
	const refused = (code: 'method-refused' | 'address-refused', message: string): Screened => ({
		ok: false,
		code,
		message,
	})
	const domain = method.slice(0, method.indexOf('.'))
	if (REFUSED.has(method) || !(OPEN_DOMAINS.has(domain) || OPEN_METHODS.has(method)))
		return refused('method-refused', WORDS_METHOD)
	switch (method) {
		case 'Page.navigate': {
			const url = screenAddress(params?.url, context.rules, context.sites)
			return url === undefined
				? refused('address-refused', WORDS_ADDRESS)
				: { ok: true, params: { ...params, url } }
		}
		case 'Fetch.continueRequest': {
			// A request may be sent on to another address; that address is judged like any other.
			if (params?.url === undefined) return { ok: true, params }
			const url = screenAddress(params.url, context.rules, context.sites)
			return url === undefined
				? refused('address-refused', WORDS_ADDRESS)
				: { ok: true, params: { ...params, url } }
		}
		case 'DOM.setFileInputFiles': {
			// A file may be given to a page's file field only from inside the work folder.
			return filesInside(params?.files, context.rules, true)
				? { ok: true, params }
				: refused('address-refused', WORDS_ADDRESS)
		}
		case 'Input.dispatchDragEvent': {
			// A drop may carry files by path; they are judged like a file field's, and none is fine.
			const data = asObject(params?.data)
			return filesInside(data?.files, context.rules, false)
				? { ok: true, params }
				: refused('address-refused', WORDS_ADDRESS)
		}
		case 'Target.setAutoAttach':
		case 'Target.getTargetInfo':
			return { ok: true, params }
		case 'Target.detachFromTarget': {
			// Only a child session this page announced may be let go; the page's own stays.
			const id = params?.sessionId
			return typeof id === 'string' && context.children.has(id)
				? { ok: true, params }
				: refused('method-refused', WORDS_METHOD)
		}
		default:
			return { ok: true, params }
	}
}

const COOKIE_NAME = /^(set-)?cookie2?$/i

/** A header map ({name: value}) or a header list ([{name, value}]) without the cookie headers. */
function withoutCookies(headers: unknown): unknown {
	if (Array.isArray(headers))
		return headers.filter((entry) => {
			const name = asObject(entry)?.name
			return !(typeof name === 'string' && COOKIE_NAME.test(name))
		})
	const map = asObject(headers)
	if (!map) return headers
	const kept: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(map)) if (!COOKIE_NAME.test(name)) kept[name] = value
	return kept
}

/**
 * Keeps cookie headers out of a network or interception event: the agent reads a page, not the
 * person's cookies (a `Set-Cookie` of an HttpOnly cookie included). Covers the request, the
 * response, the response a redirect answered with, and a paused request's response headers.
 */
function scrubHeaders(params: unknown): unknown {
	const object = asObject(params)
	if (!object) return params
	const copy = { ...object }
	for (const key of ['request', 'response', 'redirectResponse']) {
		const part = asObject(copy[key])
		if (part && part.headers !== undefined)
			copy[key] = { ...part, headers: withoutCookies(part.headers) }
	}
	if (copy.responseHeaders !== undefined)
		copy.responseHeaders = withoutCookies(copy.responseHeaders)
	return copy
}

/** Whether an event from the page is passed on. */
export function eventAllowed(method: string): boolean {
	const domain = method.slice(0, method.indexOf('.'))
	return EVENT_DOMAINS.has(domain) || NETWORK_EVENTS.has(method) || TARGET_EVENTS.has(method)
}

const sizeOf = (value: unknown): number => {
	try {
		return Buffer.byteLength(JSON.stringify(value ?? null))
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

const idText = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || !value || value.length > 400)
		throw new RelayError('not-found', `The ${label} is not known.`)
	return value
}

/**
 * Reads the site rules the engine passed. Not given (undefined or null) is `undefined`: the rules a
 * conversation already has stay. A rule that is malformed, too long or past the cap fails the open
 * rather than being cut short, because a dropped `deny` is a looser policy. Note that an empty
 * `allow` allows every site; `deny: ['*']` is how "no site" is said.
 */
export function readSites(value: unknown): SiteRules | undefined {
	if (value === undefined || value === null) return undefined
	const bad = () =>
		new RelayError('method-refused', 'The site rules are not in a form Namzu reads.')
	const object = asObject(value)
	if (!object) throw bad()
	const list = (entry: unknown): string[] | undefined => {
		if (entry === undefined) return undefined
		if (
			!Array.isArray(entry) ||
			entry.length > 512 ||
			!entry.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 253)
		)
			throw bad()
		return entry as string[]
	}
	const allow = list(object.allow)
	const deny = list(object.deny)
	return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) }
}

export class AgentPaneRelay {
	private readonly hosts = new Map<BrowserPaneHost, () => void>()
	private readonly driven = new Map<string, Map<string, Driven>>()
	private readonly listeners = new Set<(event: RelayEvent) => void>()

	constructor(private readonly deps: AgentPaneRelayDeps = {}) {}

	// ---- Windows --------------------------------------------------------------------------------

	/** A window's pane host joins; its agent tabs are the relay's to drive from now on. */
	addHost(host: BrowserPaneHost): void {
		if (this.hosts.has(host)) return
		this.hosts.set(
			host,
			host.subscribeAgent((event) => this.hostEvent(host, event)),
		)
	}

	/** A window's pane host leaves (the window closed): its tabs are let go. */
	removeHost(host: BrowserPaneHost): void {
		this.hosts.get(host)?.()
		this.hosts.delete(host)
		for (const [conversationId, tabs] of this.driven)
			for (const record of [...tabs.values()])
				if (record.host === host) this.drop(record, 'window-closed', false, conversationId)
	}

	onEvent(listener: (event: RelayEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(event: RelayEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {
				// A listener that fails does not stop the others.
			}
		}
	}

	private hostFor(conversationId: string): BrowserPaneHost | undefined {
		for (const host of this.hosts.keys()) if (host.agentTabs(conversationId).length > 0) return host
		const preferred = this.deps.preferredHost?.()
		if (preferred && this.hosts.has(preferred)) return preferred
		return this.hosts.keys().next().value
	}

	private find(conversationId: string, tabId: string): Driven | undefined {
		return this.driven.get(conversationId)?.get(tabId)
	}

	// ---- Opening ---------------------------------------------------------------------------------

	/**
	 * Opens the agent's tab in this conversation (or finds the one it has), attaches the debugger to it
	 * and returns the page's own description of itself. A debugger that cannot be attached (something
	 * else holds the page) fails the open and leaves no half-driven tab.
	 */
	async open(input: {
		conversationId: string
		rules?: unknown
	}): Promise<{ tabId: string; targetInfo: unknown }> {
		const conversationId = idText(input.conversationId, 'conversation')
		const host = this.hostFor(conversationId)
		if (!host) throw new RelayError('unavailable', 'There is no Browser pane to open a tab in.')
		const opened = host.openAgentTab(conversationId, readSites(input.rules))
		if (!opened.ok)
			throw new RelayError('tab-cap', 'Close one of the tabs Namzu opened before it opens another.')
		const record = this.drive(conversationId, host, opened.tab)
		try {
			const targetInfo = await this.targetInfo(record)
			return { tabId: opened.tab.id, targetInfo }
		} catch (error) {
			this.drop(record, 'open-failed', true, conversationId)
			throw error instanceof RelayError
				? error
				: new RelayError('cdp-error', 'The tab did not answer.')
		}
	}

	/** Attaches to the tab, or finds it already attached. Fails closed if another client holds it. */
	private drive(conversationId: string, host: BrowserPaneHost, tab: AgentTabHandle): Driven {
		const existing = this.find(conversationId, tab.id)
		if (existing?.attached && existing.dbg.isAttached()) return existing
		if (existing) this.drop(existing, 'reattach', false, conversationId, false)
		const dbg = (this.deps.debuggerOf ?? defaultDebugger)(tab.contents)
		try {
			if (dbg.isAttached()) throw new Error('attached')
			dbg.attach('1.3')
		} catch {
			this.deps.note?.('debugger-busy', { code: 'debugger-busy' })
			if (!existing) host.closeAgentTab(conversationId, tab.id)
			throw new RelayError(
				'debugger-busy',
				'Another tool is attached to this page, so Namzu cannot use it.',
			)
		}
		const record: Driven = {
			conversationId,
			host,
			tab,
			dbg,
			children: new Set(),
			attached: true,
			inFlight: 0,
			onMessage: (...args) => this.message(record, args),
			onDetach: (...args) => {
				const reason = typeof args[1] === 'string' ? args[1] : 'detached'
				this.drop(record, reason, false, conversationId)
			},
		}
		dbg.on('message', record.onMessage)
		dbg.on('detach', record.onDetach)
		let tabs = this.driven.get(conversationId)
		if (!tabs) {
			tabs = new Map()
			this.driven.set(conversationId, tabs)
		}
		tabs.set(tab.id, record)
		return record
	}

	private async targetInfo(record: Driven): Promise<unknown> {
		await record.tab.ready
		const result = asObject(await this.send(record, 'Target.getTargetInfo', {}, undefined, CALL_MS))
		return result?.targetInfo
	}

	/** Takes the debugger off a tab and forgets it. `emit` tells the engine; `forget` drops the record. */
	private drop(
		record: Driven,
		reason: string,
		closeTab: boolean,
		conversationId: string,
		emit = true,
	): void {
		if (record.attached) {
			record.attached = false
			record.dbg.removeListener('message', record.onMessage)
			record.dbg.removeListener('detach', record.onDetach)
			try {
				if (record.dbg.isAttached()) record.dbg.detach()
			} catch {
				// The page is already gone.
			}
		}
		record.children.clear()
		const tabs = this.driven.get(conversationId)
		if (tabs?.get(record.tab.id) === record) tabs.delete(record.tab.id)
		if (tabs && tabs.size === 0) this.driven.delete(conversationId)
		if (closeTab) record.host.closeAgentTab(conversationId, record.tab.id)
		if (emit) this.emit({ kind: 'detached', conversationId, tabId: record.tab.id, reason })
	}

	// ---- Calls -----------------------------------------------------------------------------------

	/** One call to a tab's page, after every check. Resolves to the page's result. */
	async cdp(input: {
		conversationId: string
		tabId: string
		method: string
		params?: unknown
		sessionId?: string
	}): Promise<unknown> {
		const conversationId = idText(input.conversationId, 'conversation')
		const tabId = idText(input.tabId, 'tab')
		const record = this.find(conversationId, tabId)
		// A tab of another conversation, of the person's, or unknown looks the same: not found.
		if (!record || !record.host.agentTab(conversationId, tabId))
			throw new RelayError('not-found', 'That tab is not one of this conversation’s.')
		if (record.host.control(conversationId, tabId) === 'person')
			throw new RelayError(
				'human-in-control',
				'The person has taken over this tab. Wait for them to hand it back.',
			)
		if (!record.attached) throw new RelayError('detached', 'The tab is no longer attached.')
		const { method } = input
		if (typeof method !== 'string' || !/^[A-Z][A-Za-z]{0,40}\.[a-zA-Z]{1,60}$/.test(method))
			throw new RelayError('method-refused', WORDS_METHOD)
		let sessionId: string | undefined
		if (input.sessionId !== undefined) {
			if (typeof input.sessionId !== 'string' || !record.children.has(input.sessionId))
				throw new RelayError('not-found', 'That session is not one of this tab’s.')
			sessionId = input.sessionId
		}
		if (input.params !== undefined && !asObject(input.params))
			throw new RelayError('method-refused', 'The call’s parameters are not an object.')
		const screened = screenMethod(method, asObject(input.params), {
			rules: record.host.addressRules(conversationId),
			sites: record.host.agentSites(conversationId),
			children: record.children,
			sessionId,
		})
		if (!screened.ok) {
			this.deps.note?.('refused', { method, code: screened.code })
			throw new RelayError(screened.code, screened.message)
		}
		const requestBytes = sizeOf(screened.params)
		if (requestBytes > MAX_REQUEST_BYTES) {
			this.deps.note?.('too-large', { method, bytes: requestBytes })
			throw new RelayError('too-large', 'That call is too large to send.')
		}
		if (this.inFlight(conversationId) >= MAX_IN_FLIGHT)
			throw new RelayError('busy', 'Too many calls are waiting on this conversation’s tabs.')
		const timeout =
			method === 'Page.captureScreenshot'
				? (this.deps.screenshotMs ?? SCREENSHOT_MS)
				: (this.deps.callMs ?? CALL_MS)
		const result = await this.send(record, method, screened.params, sessionId, timeout)
		return this.fit(method, screened.params, result)
	}

	private inFlight(conversationId: string): number {
		let total = 0
		for (const record of this.driven.get(conversationId)?.values() ?? []) total += record.inFlight
		return total
	}

	private async send(
		record: Driven,
		method: string,
		params: object | undefined,
		sessionId: string | undefined,
		timeoutMs: number,
	): Promise<unknown> {
		record.inFlight++
		record.host.setWorking(record.conversationId, record.tab.id, true)
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const call = record.dbg.sendCommand(method, params ?? {}, sessionId)
			const limit = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new RelayError('timeout', 'The page did not answer in time.')),
					timeoutMs,
				)
			})
			return await Promise.race([call, limit])
		} catch (error) {
			if (error instanceof RelayError) throw error
			// The page's own refusal, or the page went away. The wording is the protocol's; no parameter in it.
			throw new RelayError('cdp-error', error instanceof Error ? error.message : 'The call failed.')
		} finally {
			if (timer) clearTimeout(timer)
			record.inFlight--
			if (record.inFlight === 0) record.host.setWorking(record.conversationId, record.tab.id, false)
		}
	}

	/** A result inside the limit passes as it is; a screenshot over it is shrunk; anything else is refused. */
	private async fit(
		method: string,
		params: Record<string, unknown> | undefined,
		result: unknown,
	): Promise<unknown> {
		const bytes = sizeOf(result)
		if (bytes <= MAX_RESULT_BYTES) return result
		const shot = asObject(result)
		if (
			method === 'Page.captureScreenshot' &&
			typeof shot?.data === 'string' &&
			this.deps.shrinkImage
		) {
			const format = typeof params?.format === 'string' ? params.format : 'png'
			const data = await this.deps.shrinkImage(shot.data, format, MAX_RESULT_BYTES - 1024)
			if (data && sizeOf({ data }) <= MAX_RESULT_BYTES) return { ...shot, data }
		}
		this.deps.note?.('too-large', { method, bytes })
		throw new RelayError('too-large', 'The page’s answer is too large to send back.')
	}

	// ---- What the page says ----------------------------------------------------------------------

	private message(record: Driven, args: unknown[]): void {
		const method = args[1]
		const params = args[2]
		const sessionId = typeof args[3] === 'string' && args[3] ? args[3] : undefined
		if (typeof method !== 'string') return
		if (method === 'Target.attachedToTarget') {
			const id = asObject(params)?.sessionId
			if (typeof id === 'string') record.children.add(id)
		} else if (method === 'Target.detachedFromTarget') {
			const id = asObject(params)?.sessionId
			if (typeof id === 'string') record.children.delete(id)
		}
		if (!eventAllowed(method)) return
		if (sizeOf(params) > MAX_RESULT_BYTES) {
			this.deps.note?.('event-dropped', { method })
			return
		}
		this.emit({
			kind: 'cdp',
			conversationId: record.conversationId,
			tabId: record.tab.id,
			method,
			params:
				method.startsWith('Network.') || method.startsWith('Fetch.')
					? scrubHeaders(params)
					: params,
			...(sessionId ? { sessionId } : {}),
		})
	}

	/** What a pane host says about an agent's tab. */
	private hostEvent(host: BrowserPaneHost, event: AgentTabEvent): void | Promise<void> {
		switch (event.kind) {
			case 'added': {
				// A tab the engine asked for is announced by `open`; only a popup is announced here.
				if (!event.openerTabId) return
				const opener = this.find(event.sessionId, event.openerTabId)
				if (!opener || opener.host !== host) return
				return this.announcePopup(host, event)
			}
			case 'closed': {
				const record = this.find(event.sessionId, event.tabId)
				if (record) this.drop(record, 'closed', false, event.sessionId, false)
				this.emit({ kind: 'tab-closed', conversationId: event.sessionId, tabId: event.tabId })
				return
			}
			case 'control':
				this.emit({
					kind: 'state',
					conversationId: event.sessionId,
					tabId: event.tabId,
					state: event.control,
				})
		}
	}

	/** A popup of a driven page: the debugger is attached before its first address loads. */
	private async announcePopup(host: BrowserPaneHost, event: AgentTabEvent): Promise<void> {
		if (event.kind !== 'added') return
		const tab = host.agentTab(event.sessionId, event.tabId)
		if (!tab) return
		try {
			const record = this.drive(event.sessionId, host, tab)
			const targetInfo = await this.targetInfo(record)
			this.emit({
				kind: 'tab-added',
				conversationId: event.sessionId,
				tabId: event.tabId,
				...(event.openerTabId ? { openerTabId: event.openerTabId } : {}),
				targetInfo,
			})
		} catch {
			// A popup that cannot be driven is closed rather than left running unseen by the agent.
			host.closeAgentTab(event.sessionId, event.tabId)
		}
	}

	// ---- Take-over -------------------------------------------------------------------------------

	/** The person takes the tab: the agent's calls are refused until `handBack`. */
	takeOver(conversationId: string, tabId: string): boolean {
		return (
			this.find(conversationId, tabId)?.host.setControl(conversationId, tabId, 'person') ?? false
		)
	}

	handBack(conversationId: string, tabId: string): boolean {
		return (
			this.find(conversationId, tabId)?.host.setControl(conversationId, tabId, 'agent') ?? false
		)
	}

	// ---- Letting go ------------------------------------------------------------------------------

	/** Closes a tab the engine asked to close, or all of the conversation's when none is named. */
	close(input: { conversationId: string; tabId?: string }): void {
		const conversationId = idText(input.conversationId, 'conversation')
		const records = [...(this.driven.get(conversationId)?.values() ?? [])]
		for (const record of records) {
			if (input.tabId !== undefined && record.tab.id !== input.tabId) continue
			this.drop(record, 'closed-by-engine', true, conversationId, false)
		}
	}

	/** The conversation ended: its tabs are detached and closed. */
	conversationEnded(conversationId: string): void {
		for (const record of [...(this.driven.get(conversationId)?.values() ?? [])])
			this.drop(record, 'conversation-ended', true, conversationId, false)
		for (const host of this.hosts.keys()) host.closeAgentTabs(conversationId)
	}

	/**
	 * Detaches every debugger: the engine restarted, or a setting that changes the agent's partition
	 * did. `closeTabs` also closes the tabs (a new partition cannot take over an open page).
	 */
	releaseAll(reason: string, closeTabs: boolean): void {
		for (const [conversationId, tabs] of [...this.driven])
			for (const record of [...tabs.values()]) this.drop(record, reason, closeTabs, conversationId)
		if (closeTabs)
			for (const host of this.hosts.keys())
				for (const conversationId of conversationsOf(host)) host.closeAgentTabs(conversationId)
	}

	dispose(): void {
		this.releaseAll('disposed', false)
		for (const stop of this.hosts.values()) stop()
		this.hosts.clear()
		this.listeners.clear()
	}
}

const conversationsOf = (host: BrowserPaneHost): string[] => host.conversations()

function defaultDebugger(contents: WebContents): DebuggerLike {
	return contents.debugger as unknown as DebuggerLike
}
