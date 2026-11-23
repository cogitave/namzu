/**
 * The agent's browser in the desktop application's Browser pane, from the engine's side.
 *
 * Under `namzu acp --desktop` the application can own the pages the agent works in: a tab of its
 * own Browser pane, which the person watches and can sign in to. The application tells the engine so
 * at `initialize` by naming the capability below; the engine then builds the agent's browser host
 * over a {@link PaneChannel} that speaks to the application on the connection it already has, and
 * the host drives the pane's tab with the same code that drives its own browser. Nothing here opens
 * a port: every protocol command is one request to the application and one answer.
 *
 * Requests the engine sends (the application answers):
 *
 * - `namzu/browser/pane/open` `{ sessionId, rules? }` returns `{ tabId, targetInfo }`: the
 *   conversation's agent tab, opened or found. `rules` is the site rule set (`allow`/`deny` host
 *   patterns) the application enforces under the engine's own.
 * - `namzu/browser/pane/cdp` `{ sessionId, tabId, method, params?, cdpSessionId? }` returns the
 *   protocol result, or an error whose message is plain words.
 * - `namzu/browser/pane/close` `{ sessionId, tabId? }`: let go of the agent's tab, or all of them.
 *
 * Notifications the application sends (the engine serves these as methods):
 *
 * - `namzu/browser/pane/event` `{ sessionId, kind, tabId, ... }`: a page event (`cdp`, with
 *   `method`, `params` and the child `cdpSessionId`), a tab a page opened (`tab-added`), a tab that
 *   is gone (`tab-closed`) or whose debugger was taken away (`detached`).
 * - `namzu/browser/pane/state` `{ sessionId, tabId, state }`: `agent` or `person` holds the tab.
 *
 * An application that did not name the capability is never asked anything, and the host opens its
 * own browser as it always did.
 */
import type { PaneChannel, PaneEvent, PaneTabRef } from '@namzu/browser'
import type { BrowserSitesConfig } from '../permissions/browser-sites.js'

/** What the application names in `initialize` when it can host the agent's browser. */
export const BROWSER_PANE_CAPABILITY = 'namzu/browser-pane'

export const BROWSER_PANE_METHODS = {
	open: 'namzu/browser/pane/open',
	cdp: 'namzu/browser/pane/cdp',
	close: 'namzu/browser/pane/close',
	event: 'namzu/browser/pane/event',
	state: 'namzu/browser/pane/state',
} as const

/** The methods the engine serves for the application to call, as the application probes for them. */
export const BROWSER_PANE_SERVED_METHODS: readonly string[] = [
	BROWSER_PANE_METHODS.event,
	BROWSER_PANE_METHODS.state,
]

/** The connection to the application, as far as this needs it. */
export interface PaneConnection {
	/** The application named `capability` at `initialize`. */
	offers(capability: string): boolean
	/** One request to the application and its answer; rejects with the application's own words. */
	ask(method: string, params: Record<string, unknown>): Promise<unknown>
}

export interface PaneRules {
	readonly allow?: readonly string[]
	readonly deny?: readonly string[]
}

export type PaneControl = 'agent' | 'person'

/** A channel to the pane for one conversation, with what the application said about who holds the tab. */
export interface AcpPaneChannel extends PaneChannel {
	/** Who holds the agent's tab now, as the application last said. */
	control(): PaneControl
}

export interface AcpPaneLink {
	/** The application can host the agent's browser. */
	available(): boolean
	/** A channel for one conversation. Its tabs open on the first `listTabs`. */
	channel(sessionId: string, rules?: PaneRules): AcpPaneChannel
	/** Served to the application: its events and state changes. */
	readonly extensions: Readonly<Record<string, (params: Record<string, unknown>) => unknown>>
	/** The connection is gone: every channel reports it and no further request is made. */
	close(reason?: string): void
}

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' && value.length <= 400 ? value : undefined

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

export function createAcpPaneLink(connection: PaneConnection): AcpPaneLink {
	const channels = new Set<Channel>()
	let closed: string | undefined

	class Channel implements AcpPaneChannel {
		private readonly events = new Set<(event: PaneEvent) => void>()
		private readonly added = new Set<(tab: PaneTabRef) => void>()
		private readonly gone = new Set<(tabId: string) => void>()
		private readonly closes = new Set<(reason?: string) => void>()
		private opened: Promise<readonly PaneTabRef[]> | undefined
		private primary: string | undefined
		private readonly tabs = new Set<string>()
		private holder: PaneControl = 'agent'
		private done = false

		constructor(
			readonly sessionId: string,
			private readonly rules: PaneRules | undefined,
		) {
			channels.add(this)
		}

		control(): PaneControl {
			return this.holder
		}

		private ask(method: string, params: Record<string, unknown>): Promise<unknown> {
			if (this.done || closed !== undefined)
				return Promise.reject(new Error('The Browser pane is not connected.'))
			return connection.ask(method, { sessionId: this.sessionId, ...params })
		}

		listTabs(): Promise<readonly PaneTabRef[]> {
			// The tab opens once; a later list is the tabs known now, in the order they were seen.
			this.opened ??= this.ask(BROWSER_PANE_METHODS.open, {
				...(this.rules?.allow?.length || this.rules?.deny?.length ? { rules: this.rules } : {}),
			}).then((reply) => {
				const tabId = text(object(reply)?.tabId)
				if (!tabId) throw new Error('The Browser pane did not name the tab it opened.')
				this.primary = tabId
				this.tabs.add(tabId)
				return [{ tabId }]
			})
			return this.opened.then(() => [...this.tabs].map((tabId) => ({ tabId })))
		}

		async cdp(
			tabId: string,
			method: string,
			params?: object,
			sessionId?: string,
		): Promise<unknown> {
			const reply = await this.ask(BROWSER_PANE_METHODS.cdp, {
				tabId,
				method,
				...(params !== undefined ? { params } : {}),
				...(sessionId !== undefined ? { cdpSessionId: sessionId } : {}),
			})
			// The application answers `{ result }`; a bare result is read as it is.
			const answer = object(reply)
			return answer && 'result' in answer ? answer.result : reply
		}

		onEvent(listener: (event: PaneEvent) => void): () => void {
			this.events.add(listener)
			return () => this.events.delete(listener)
		}

		onTabAdded(listener: (tab: PaneTabRef) => void): () => void {
			this.added.add(listener)
			return () => this.added.delete(listener)
		}

		onTabClosed(listener: (tabId: string) => void): () => void {
			this.gone.add(listener)
			return () => this.gone.delete(listener)
		}

		onClose(listener: (reason?: string) => void): () => void {
			this.closes.add(listener)
			return () => this.closes.delete(listener)
		}

		// The first tab stays: it is the one the conversation always has, and the host has nowhere
		// to go if it is closed. A tab a page opened can be closed.
		async closeTab(tabId: string): Promise<void> {
			if (tabId === this.primary)
				throw new Error(
					'The Browser pane keeps this conversation’s first tab open. Open another address in it instead.',
				)
			await this.ask(BROWSER_PANE_METHODS.close, { tabId })
			this.forget(tabId)
		}

		async close(): Promise<void> {
			if (this.done) return
			const wasOpen = this.opened !== undefined && closed === undefined
			this.done = true
			channels.delete(this)
			if (wasOpen)
				await connection
					.ask(BROWSER_PANE_METHODS.close, { sessionId: this.sessionId })
					.catch(() => undefined)
		}

		// ---- What the application says ----------------------------------------------------------

		forget(tabId: string): void {
			if (!this.tabs.delete(tabId)) return
			for (const listener of [...this.gone]) listener(tabId)
		}

		receive(body: Record<string, unknown>): void {
			if (this.done) return
			const tabId = text(body.tabId)
			if (!tabId) return
			switch (body.kind) {
				case 'cdp': {
					const method = text(body.method)
					if (!method) return
					const sessionId = text(body.cdpSessionId)
					const event: PaneEvent = {
						tabId,
						method,
						...(body.params !== undefined ? { params: body.params } : {}),
						...(sessionId ? { sessionId } : {}),
					}
					for (const listener of [...this.events]) listener(event)
					return
				}
				case 'tab-added':
					if (this.tabs.has(tabId)) return
					this.tabs.add(tabId)
					for (const listener of [...this.added]) listener({ tabId })
					return
				case 'tab-closed':
				case 'detached':
					this.forget(tabId)
			}
		}

		setControl(state: PaneControl): void {
			this.holder = state
		}

		fail(reason: string | undefined): void {
			if (this.done) return
			this.done = true
			channels.delete(this)
			for (const listener of [...this.closes]) listener(reason)
		}
	}

	const forSession = (params: Record<string, unknown>): Channel[] => {
		const id = text(params.sessionId)
		return id ? [...channels].filter((channel) => channel.sessionId === id) : []
	}

	return {
		available: () => closed === undefined && connection.offers(BROWSER_PANE_CAPABILITY),
		channel: (sessionId, rules) => new Channel(sessionId, rules),
		extensions: {
			[BROWSER_PANE_METHODS.event]: (params) => {
				for (const channel of forSession(params)) channel.receive(params)
				return null
			},
			[BROWSER_PANE_METHODS.state]: (params) => {
				const state =
					params.state === 'person' ? 'person' : params.state === 'agent' ? 'agent' : undefined
				if (state) for (const channel of forSession(params)) channel.setControl(state)
				return null
			},
		},
		close: (reason) => {
			if (closed !== undefined) return
			closed = reason ?? 'The connection to the app closed.'
			for (const channel of [...channels]) channel.fail(closed)
		},
	}
}

// ---- Site rules ---------------------------------------------------------------------------------

/** The host a site key names (`https://*.example.com:8443` is `*.example.com`), or undefined. */
function hostOfKey(key: string): string | undefined {
	const match = /^https?:\/\/((?:\*\.)?[^:/]+)(?::(?:\*|\d+))?$/.exec(key)
	return match?.[1]?.toLowerCase()
}

/**
 * `browser.sites` as the application's second layer reads it: host patterns to refuse and, when the
 * default level is `deny`, hosts to allow. The engine's own gate stays the first layer and does the
 * per-site asking; this only keeps a faulty engine from reaching a site the rules close. A port in a
 * key is dropped (a `deny` then covers the whole host, a stricter reading). Returns `undefined` when
 * a key cannot be said as a host pattern: the pane is then not used, and the engine's own browser,
 * which enforces every key as written, runs instead.
 */
export function paneSiteRules(sites: BrowserSitesConfig): PaneRules | undefined {
	const deny = new Set<string>()
	const allow = new Set<string>()
	let defaultLevel = 'ask'
	for (const [key, level] of Object.entries(sites)) {
		if (key === '*') {
			defaultLevel = level
			continue
		}
		const host = hostOfKey(key)
		if (!host) return undefined
		if (level === 'deny') deny.add(host)
		else allow.add(host)
	}
	if (defaultLevel === 'deny') {
		return allow.size > 0
			? { allow: [...allow], ...(deny.size ? { deny: [...deny] } : {}) }
			: { deny: ['*'] }
	}
	return deny.size > 0 ? { deny: [...deny] } : {}
}
