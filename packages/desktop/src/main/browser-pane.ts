import { createHash, randomUUID } from 'node:crypto'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import {
	type BrowserBounds,
	type BrowserPaneRequest,
	type BrowserPaneState,
	type BrowserTabControl,
	type BrowserTabOwner,
	type BrowserTabView,
	MAX_AGENT_BROWSER_TABS,
	MAX_BROWSER_TABS,
} from '../shared/browser-pane.js'
import type { BrowserCookieScope } from '../shared/settings-protocol.js'
import {
	type AddressRules,
	type SiteRules,
	addressText,
	fileAllowed,
	resolveAddress,
	siteAllowed,
} from './browser-address.js'

/**
 * The Browser pane's pages.
 *
 * Safety model. A page here is untrusted web content, so it is kept as far from the app as a page
 * in any other browser: each page is its own `WebContentsView`, never a `<webview>` (the main
 * window still refuses those), with no preload, no Node, context isolation and the sandbox on. Its
 * session is a partition of its own and holds no cookie, storage or cache of the app. How long a
 * sign-in in it lasts is the person's choice (`browserCookies`, read when a tab is made): one
 * partition shared by every conversation and gone when the app closes, a `persist:` partition kept
 * across restarts, or a partition for each conversation, gone when the app closes. Every permission a
 * page can ask for (camera, microphone, notifications, location, a device) is denied, a download
 * is refused, and `window.open` opens a tab in this pane instead of a window. A page may load
 * `http` and `https` addresses; a `file:` address, whether typed, linked, redirected to or
 * fetched by a page as a script, style or image, is allowed only inside the conversation's work
 * folder (see `browser-address.ts`).
 *
 * Tabs the agent opens obey every rule above. They differ in four ways: each has an owner, the agent's
 * tabs count against a cap of their own (`MAX_AGENT_BROWSER_TABS`) and never use up the person's;
 * they live in a partition of their own, so the person's sign-ins are out of the agent's reach;
 * they are never removed from the window or moved off it while the agent drives them (a page that is
 * not in the window cannot be captured), only hidden; and background throttling is off for them so a
 * page the person is not looking at still runs. The agent reaches them only through
 * `agent-pane-relay.ts`, which is the one place a debugger is attached.
 */

const MAX_TABS = MAX_BROWSER_TABS
/** How long an agent's tab still reads as working after its last call, so a run of calls shows as one. */
export const WORKING_LINGER_MS = 600
/** The size an agent's tab has while it is not on screen, so its page still lays out like a window. */
const HIDDEN_SIZE = { x: 0, y: 0, width: 1280, height: 800 }

type View = WebContentsView
interface Tab {
	id: string
	view: View
	title: string
	loading: boolean
	owner: BrowserTabOwner
	control: BrowserTabControl
	/** The tab that asked for this one, for a popup of an agent's tab. */
	opener?: string
	/** Settles when a page is in the view that a debugger can talk to. */
	ready?: Promise<void>
	/** An agent's tab: true while a call is on the page, and for a moment after so the mark does not flicker. */
	working?: boolean
	/** Clears `working` a moment after the last call ended. */
	workingTimer?: ReturnType<typeof setTimeout>
}
/** Whether `next` is no looser than `current`: every deny kept, and an allow list only narrower. */
export function siteRulesTighten(current: SiteRules, next: SiteRules): boolean {
	const denied = new Set(next.deny ?? [])
	if (!(current.deny ?? []).every((entry) => denied.has(entry))) return false
	const was = current.allow ?? []
	if (was.length === 0) return true
	const now = next.allow ?? []
	if (now.length === 0) return false
	const allowed = new Set(was)
	return now.every((entry) => allowed.has(entry))
}

interface Browser {
	tabs: Tab[]
	/** The sites the agent's tabs here may reach, as passed when the agent opened its first tab. */
	agentSites?: SiteRules
	active?: string
	notice?: string
	/** The picture standing in for the page while something lies over it. */
	still?: string
}

/** What the host says about an agent's tab, to whoever drives it. */
export type AgentTabEvent =
	| { kind: 'added'; sessionId: string; tabId: string; openerTabId?: string }
	| { kind: 'closed'; sessionId: string; tabId: string }
	| { kind: 'control'; sessionId: string; tabId: string; control: BrowserTabControl }

/** An agent's tab as the relay sees it: its id and the page, never the view. */
export interface AgentTabHandle {
	id: string
	contents: WebContents
	/** Settles when the tab holds a page; a debugger sent a call before that waits for it. */
	ready: Promise<void>
}

export type AgentTabRefusal = 'tab-cap' | 'address'

export interface BrowserPaneDeps {
	window: BrowserWindow
	/** Builds a view from web preferences; Electron's `WebContentsView`. */
	createView: (partition: string) => View
	sessionOf: (partition: string) => Session
	/** The conversation's work folder, from the host's own record; undefined when it has none. */
	workFolder: (sessionId: string) => string | undefined
	caseless: boolean
	send: (state: BrowserPaneState) => void
	/** How long sign-ins last, read each time a tab is made so a change reaches new tabs. */
	cookieScope: () => BrowserCookieScope
}

/** The partition of the built-in browser's tabs: where its cookies and storage live. */
export function partitionOf(scope: BrowserCookieScope, sessionId: string): string {
	if (scope === 'restarts') return 'persist:namzu-browser'
	if (scope === 'quit') return 'namzu-browser-shared'
	return `namzu-browser-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
}

/**
 * The partition of the agent's tabs. They never share one with the person's, so a sign-in the person
 * made in their own tabs is not in the agent's reach. The choice of how long it lasts is the same
 * setting as for the person's.
 */
export function agentPartitionOf(scope: BrowserCookieScope, sessionId: string): string {
	if (scope === 'restarts') return AGENT_PERSISTENT_PARTITION
	if (scope === 'quit') return 'namzu-agent-shared'
	return `namzu-agent-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
}

/** The agent's `persist:` partition, which clearing sign-ins must clear with the person's. */
export const AGENT_PERSISTENT_PARTITION = 'persist:namzu-agent'

/** The windows that share a session, by session: one request handler serves them all. */
const hostsOfSession = new WeakMap<object, Set<BrowserPaneHost>>()
const knownSessions = new Set<WeakRef<object>>()
function hostsOfSessions(): Set<BrowserPaneHost>[] {
	const out: Set<BrowserPaneHost>[] = []
	for (const ref of knownSessions) {
		const ses = ref.deref()
		const peers = ses && hostsOfSession.get(ses)
		if (peers) out.push(peers)
		else knownSessions.delete(ref)
	}
	return out
}

/** One window's browser pages, kept per conversation. */
export class BrowserPaneHost {
	private readonly browsers = new Map<string, Browser>()
	private readonly guarded = new Set<string>()
	private attached: { sessionId: string; tab: Tab } | undefined
	/** Where the renderer last asked for the page, so a tab that changes is put there at once. */
	private placed: { sessionId: string; bounds: BrowserBounds } | undefined
	private disposed = false
	private readonly agentListeners = new Set<(event: AgentTabEvent) => void | Promise<void>>()
	/** Counts every placing and every freezing, so a picture that arrives late can tell it is stale. */
	private stillToken = 0

	constructor(private readonly deps: BrowserPaneDeps) {}

	private rules(sessionId: string): AddressRules {
		return { workFolder: this.deps.workFolder(sessionId), caseless: this.deps.caseless }
	}

	private browser(sessionId: string): Browser {
		let browser = this.browsers.get(sessionId)
		if (!browser) {
			browser = { tabs: [] }
			this.browsers.set(sessionId, browser)
		}
		return browser
	}

	private tabOfContents(
		webContentsId: number | undefined,
	): { sessionId: string; tab: Tab } | undefined {
		if (webContentsId === undefined) return undefined
		for (const [sessionId, browser] of this.browsers) {
			const tab = browser.tabs.find((candidate) => candidate.view.webContents.id === webContentsId)
			if (tab) return { sessionId, tab }
		}
		return undefined
	}

	/**
	 * Whether a request is cancelled, or undefined when none of this window's tabs asked. A file is
	 * judged by the work folder of the conversation whose tab asked. The agent's site rules are a
	 * second layer under the engine's own: a page of an agent's tab may not be taken to a site the
	 * rules shut, whatever asked for it. Only a page (the main frame or a frame in it) is judged; a
	 * script or image from another host is not a visit.
	 */
	judgeRequest(details: {
		url: string
		webContentsId?: number
		resourceType?: string
	}): boolean | undefined {
		const asked = this.tabOfContents(details.webContentsId)
		if (!asked) return undefined
		const blocked =
			details.url.startsWith('file:') && !fileAllowed(details.url, this.rules(asked.sessionId))
		const shut =
			asked.tab.owner === 'agent' &&
			(details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') &&
			!siteAllowed(details.url, this.browser(asked.sessionId).agentSites)
		return blocked || shut
	}

	/** Shuts a partition's doors once: permissions, downloads and files outside the work folder. */
	private guard(sessionId: string, owner: BrowserTabOwner = 'person'): string {
		const scope = this.deps.cookieScope()
		const partition =
			owner === 'agent' ? agentPartitionOf(scope, sessionId) : partitionOf(scope, sessionId)
		if (this.guarded.has(partition)) return partition
		this.guarded.add(partition)
		const ses = this.deps.sessionOf(partition)
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
		ses.setPermissionCheckHandler(() => false)
		ses.setDevicePermissionHandler(() => false)
		ses.on('will-download', (event) => event.preventDefault())
		// One handler per session, however many windows share it: Electron keeps only the last handler
		// set on a session, so each window joins a registry and the one handler asks them all.
		let peers = hostsOfSession.get(ses)
		if (peers) {
			peers.add(this)
			return partition
		}
		peers = new Set([this])
		hostsOfSession.set(ses, peers)
		knownSessions.add(new WeakRef(ses))
		const hosts = peers
		ses.webRequest.onBeforeRequest((details, callback) => {
			let verdict: boolean | undefined
			for (const host of hosts) {
				verdict = host.judgeRequest(details)
				if (verdict !== undefined) break
			}
			// A request from no known tab may load no file.
			callback({ cancel: verdict ?? details.url.startsWith('file:') })
		})
		return partition
	}

	private view(sessionId: string): BrowserPaneState {
		const browser = this.browser(sessionId)
		return {
			sessionId,
			tabs: browser.tabs.map((tab): BrowserTabView => {
				const contents = tab.view.webContents
				const url = contents.getURL()
				return {
					id: tab.id,
					title: tab.title || addressText(url) || 'New tab',
					address: addressText(url),
					loading: tab.loading,
					canGoBack: contents.navigationHistory.canGoBack(),
					canGoForward: contents.navigationHistory.canGoForward(),
					owner: tab.owner,
					...(tab.owner === 'agent'
						? { control: tab.control, ...(tab.working ? { working: true } : {}) }
						: {}),
				}
			}),
			...(browser.active ? { active: browser.active } : {}),
			...(browser.notice ? { notice: browser.notice } : {}),
			...(browser.still ? { still: browser.still } : {}),
		}
	}

	private emit(sessionId: string): void {
		if (!this.disposed) this.deps.send(this.view(sessionId))
	}

	private refuse(sessionId: string, reason: string): void {
		this.browser(sessionId).notice = reason
		this.emit(sessionId)
	}

	private watch(sessionId: string, tab: Tab): void {
		const contents: WebContents = tab.view.webContents
		const changed = () => this.emit(sessionId)
		contents.on('page-title-updated', (_event, title) => {
			tab.title = title
			changed()
		})
		contents.on('did-start-loading', () => {
			tab.loading = true
			changed()
		})
		contents.on('did-stop-loading', () => {
			tab.loading = false
			changed()
		})
		contents.on('did-navigate', () => {
			tab.title = ''
			changed()
		})
		contents.on('did-navigate-in-page', changed)
		const guardNavigation = (event: { preventDefault: () => void }, url: string) => {
			if (url === 'about:blank') return
			const found = resolveAddress(url, this.rules(sessionId))
			if (!found.ok) {
				event.preventDefault()
				this.refuse(sessionId, found.reason)
			} else if (
				tab.owner === 'agent' &&
				!siteAllowed(found.url, this.browser(sessionId).agentSites)
			) {
				event.preventDefault()
				this.refuse(sessionId, 'This site is not open to Namzu here.')
			}
		}
		contents.on('will-navigate', (event, url) => guardNavigation(event, url))
		contents.on('will-redirect', (event, url) => guardNavigation(event, url))
		// A page that asks for a window gets a tab in this pane, never a window.
		// A page of an agent's tab opens an agent's tab, which the agent is told about by its opener.
		contents.setWindowOpenHandler(({ url }) => {
			if (tab.owner === 'agent') this.createAgent(sessionId, url, tab.id)
			else this.create(sessionId, url)
			return { action: 'deny' }
		})
		contents.on('render-process-gone', () => {
			tab.loading = false
			changed()
		})
	}

	private create(sessionId: string, address?: string): Tab | undefined {
		const browser = this.browser(sessionId)
		const found = address ? resolveAddress(address, this.rules(sessionId)) : undefined
		if (found && !found.ok) {
			this.refuse(sessionId, found.reason)
			return undefined
		}
		if (browser.tabs.filter((tab) => tab.owner === 'person').length >= MAX_TABS) {
			this.refuse(sessionId, 'Close a tab before opening another.')
			return undefined
		}
		const view = this.deps.createView(this.guard(sessionId))
		const tab: Tab = {
			id: randomUUID(),
			view,
			title: '',
			loading: false,
			owner: 'person',
			control: 'agent',
		}
		browser.tabs.push(tab)
		browser.active = tab.id
		browser.notice = undefined
		this.watch(sessionId, tab)
		if (found?.ok) void view.webContents.loadURL(found.url).catch(() => undefined)
		this.emit(sessionId)
		return tab
	}

	/**
	 * Makes a tab for the agent. The page is put in the window at once, hidden, because a page that is
	 * not in the window cannot be captured; background throttling is off so it keeps running while
	 * nobody looks at it. Whoever drives it hears of the tab before the first address loads, so
	 * nothing the page does first is missed.
	 */
	private createAgent(sessionId: string, address?: string, opener?: string): Tab | undefined {
		const browser = this.browser(sessionId)
		const found = address ? resolveAddress(address, this.rules(sessionId)) : undefined
		if (found && !found.ok) {
			this.refuse(sessionId, found.reason)
			return undefined
		}
		if (found?.ok && !siteAllowed(found.url, browser.agentSites)) {
			this.refuse(sessionId, 'This site is not open to Namzu here.')
			return undefined
		}
		if (browser.tabs.filter((tab) => tab.owner === 'agent').length >= MAX_AGENT_BROWSER_TABS) {
			this.refuse(sessionId, 'Close one of the tabs Namzu opened before it opens another.')
			return undefined
		}
		const view = this.deps.createView(this.guard(sessionId, 'agent'))
		const tab: Tab = {
			id: randomUUID(),
			view,
			title: '',
			loading: false,
			owner: 'agent',
			control: 'agent',
			...(opener ? { opener } : {}),
		}
		view.webContents.setBackgroundThrottling(false)
		view.setVisible(false)
		view.setBounds({ ...HIDDEN_SIZE })
		if (!this.deps.window.isDestroyed()) this.deps.window.contentView.addChildView(view)
		browser.tabs.push(tab)
		browser.active = tab.id
		browser.notice = undefined
		this.watch(sessionId, tab)
		this.refreshPlacement(sessionId)
		// A view with no page has nothing for a debugger to talk to, so every tab first holds a blank
		// page; whoever drives the tab is told after that and before the real address loads.
		tab.ready = view.webContents.loadURL('about:blank').catch(() => undefined)
		const heard = tab.ready.then(() =>
			this.tell({
				kind: 'added',
				sessionId,
				tabId: tab.id,
				...(opener ? { openerTabId: opener } : {}),
			}),
		)
		if (found?.ok) {
			const url = found.url
			void heard.then(() => {
				if (browser.tabs.includes(tab)) return view.webContents.loadURL(url).catch(() => undefined)
			})
		}
		this.emit(sessionId)
		return tab
	}

	/** Tells every listener; the returned promise settles when each has answered. */
	private tell(event: AgentTabEvent): Promise<void> {
		const answers: Promise<unknown>[] = []
		for (const listener of this.agentListeners) {
			try {
				answers.push(Promise.resolve(listener(event)))
			} catch {
				// A listener that fails does not stop the others or the tab.
			}
		}
		return Promise.allSettled(answers).then(() => undefined)
	}

	/** Puts the active tab where the renderer last asked for the page, after a change not made through `handle`. */
	private refreshPlacement(sessionId: string): void {
		if (this.placed?.sessionId === sessionId) this.place(sessionId, this.placed.bounds)
	}

	private activeTab(sessionId: string): Tab | undefined {
		const browser = this.browser(sessionId)
		return browser.tabs.find((tab) => tab.id === browser.active)
	}

	/** Takes whatever page is on screen off it. */
	private detach(): void {
		if (!this.attached) return
		const { tab } = this.attached
		this.attached = undefined
		// An agent's tab only hides: taking its view out of the window would stop it being captured.
		if (tab.owner === 'agent') {
			tab.view.setVisible(false)
			return
		}
		if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(tab.view)
	}

	/**
	 * A menu or dialog lies over the pane. The page is a view above the app's own page, so it would
	 * hide that menu: a picture of it is taken and sent to stand in, and the page steps aside until it
	 * is placed again.
	 */
	private async freeze(sessionId: string): Promise<void> {
		const tab = this.activeTab(sessionId)
		if (!tab || this.attached?.tab !== tab) return
		const token = ++this.stillToken
		let still: string | undefined
		try {
			const image = await tab.view.webContents.capturePage()
			if (!image.isEmpty()) still = `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`
		} catch {
			// No picture: the area stays blank while the menu is open.
		}
		// A placing that arrived while the picture was taken says the page is wanted again.
		if (this.disposed || token !== this.stillToken) return
		const browser = this.browser(sessionId)
		if (still) browser.still = still
		this.placed = undefined
		this.detach()
		this.emit(sessionId)
	}

	private place(sessionId: string, bounds: BrowserBounds | null): void {
		this.stillToken++
		const stale = this.browser(sessionId).still !== undefined
		if (stale) this.browser(sessionId).still = undefined
		this.placed = bounds ? { sessionId, bounds } : undefined
		const tab = this.activeTab(sessionId)
		if (!bounds || !tab || bounds.width < 2 || bounds.height < 2) {
			this.detach()
			return
		}
		if (this.attached?.tab !== tab) {
			this.detach()
			if (tab.owner === 'agent') tab.view.setVisible(true)
			else this.deps.window.contentView.addChildView(tab.view)
			this.attached = { sessionId, tab }
		}
		tab.view.setBounds({
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.round(bounds.width),
			height: Math.round(bounds.height),
		})
		// The page is back where it was: the picture that stood in for it goes.
		if (stale) this.emit(sessionId)
	}

	private closeTab(sessionId: string, tabId: string): void {
		const browser = this.browser(sessionId)
		const at = browser.tabs.findIndex((tab) => tab.id === tabId)
		const tab = browser.tabs[at]
		if (!tab) return
		if (tab.workingTimer) clearTimeout(tab.workingTimer)
		if (this.attached?.tab === tab) this.detach()
		browser.tabs.splice(at, 1)
		if (browser.active === tabId) browser.active = (browser.tabs[at] ?? browser.tabs[at - 1])?.id
		if (tab.owner === 'agent') {
			if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(tab.view)
			void this.tell({ kind: 'closed', sessionId, tabId })
		}
		tab.view.webContents.close()
		this.emit(sessionId)
	}

	/** Subscribes to what happens to the agent's tabs. Returns the way to stop. */
	subscribeAgent(listener: (event: AgentTabEvent) => void | Promise<void>): () => void {
		this.agentListeners.add(listener)
		return () => this.agentListeners.delete(listener)
	}

	/** Whether this window holds any tab of the conversation. */
	holds(sessionId: string): boolean {
		return (this.browsers.get(sessionId)?.tabs.length ?? 0) > 0
	}

	/** The conversations that have an agent tab in this window. */
	conversations(): string[] {
		return [...this.browsers]
			.filter(([, browser]) => browser.tabs.some((tab) => tab.owner === 'agent'))
			.map(([sessionId]) => sessionId)
	}

	/** The address rules of a conversation, for the one who checks an address before it is loaded. */
	addressRules(sessionId: string): AddressRules {
		return this.rules(sessionId)
	}

	/** The site rules that bind the agent's tabs in this conversation, if the agent set any. */
	agentSites(sessionId: string): SiteRules | undefined {
		return this.browsers.get(sessionId)?.agentSites
	}

	/** An agent's tab of this conversation. A tab of the person's, or of another conversation, is not found. */
	agentTab(sessionId: string, tabId: string): AgentTabHandle | undefined {
		const tab = this.browsers.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId)
		return tab?.owner === 'agent'
			? { id: tab.id, contents: tab.view.webContents, ready: tab.ready ?? Promise.resolve() }
			: undefined
	}

	agentTabs(sessionId: string): AgentTabHandle[] {
		return (this.browsers.get(sessionId)?.tabs ?? [])
			.filter((tab) => tab.owner === 'agent')
			.map((tab) => ({
				id: tab.id,
				contents: tab.view.webContents,
				ready: tab.ready ?? Promise.resolve(),
			}))
	}

	/**
	 * Opens a tab for the agent, or reuses the one it has. `sites` binds every agent tab of the
	 * conversation from now on (left alone when not given). A refused open names why.
	 */
	openAgentTab(
		sessionId: string,
		sites?: SiteRules,
	): { ok: true; tab: AgentTabHandle; reused: boolean } | { ok: false; reason: AgentTabRefusal } {
		if (this.disposed) return { ok: false, reason: 'tab-cap' }
		const browser = this.browser(sessionId)
		// Rules bind from the first open that gives them. While the same engine holds the tabs a
		// later open may only tighten them: rules that would reach a site the first set shut are
		// ignored. They start again when the engine lets go, goes away, or the conversation ends.
		if (
			sites !== undefined &&
			(browser.agentSites === undefined || siteRulesTighten(browser.agentSites, sites))
		)
			browser.agentSites = sites
		const have = this.agentTabs(sessionId)
		const first = have[0]
		if (first) return { ok: true, tab: first, reused: true }
		const tab = this.createAgent(sessionId)
		return tab
			? {
					ok: true,
					tab: {
						id: tab.id,
						contents: tab.view.webContents,
						ready: tab.ready ?? Promise.resolve(),
					},
					reused: false,
				}
			: { ok: false, reason: 'tab-cap' }
	}

	closeAgentTab(sessionId: string, tabId: string): void {
		if (this.agentTab(sessionId, tabId)) this.closeTab(sessionId, tabId)
	}

	/** The engine let go, or the conversation ended, or a setting that changes the agent's tabs did: its site rules start again. */
	forgetAgentSites(sessionId: string): void {
		const browser = this.browsers.get(sessionId)
		if (browser) browser.agentSites = undefined
	}

	closeAgentTabs(sessionId: string): void {
		for (const tab of this.agentTabs(sessionId)) this.closeTab(sessionId, tab.id)
	}

	/** Who holds the tab; undefined for a tab that is not the agent's. */
	control(sessionId: string, tabId: string): BrowserTabControl | undefined {
		const tab = this.browsers.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId)
		return tab?.owner === 'agent' ? tab.control : undefined
	}

	/**
	 * The person takes an agent's tab (`person`: the agent's calls are refused) or hands it back
	 * (`agent`). The renderer's controls for it call this.
	 */
	setControl(sessionId: string, tabId: string, control: BrowserTabControl): boolean {
		const tab = this.browsers.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId)
		if (!tab || tab.owner !== 'agent') return false
		if (tab.control !== control) {
			tab.control = control
			void this.tell({ kind: 'control', sessionId, tabId, control })
			this.emit(sessionId)
		}
		return true
	}

	/**
	 * The agent has a call on the tab (`true`) or its last call ended (`false`; the mark stays a moment
	 * longer). The renderer shows it beside the agent's marker. Nothing about the call is kept.
	 */
	setWorking(sessionId: string, tabId: string, working: boolean): void {
		if (this.disposed) return
		const tab = this.browsers.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId)
		if (!tab || tab.owner !== 'agent') return
		if (tab.workingTimer) clearTimeout(tab.workingTimer)
		tab.workingTimer = undefined
		if (working) {
			if (!tab.working) {
				tab.working = true
				this.emit(sessionId)
			}
			return
		}
		if (!tab.working) return
		tab.workingTimer = setTimeout(() => {
			tab.workingTimer = undefined
			tab.working = false
			this.emit(sessionId)
		}, WORKING_LINGER_MS)
	}

	handle(sessionId: string, request: BrowserPaneRequest): BrowserPaneState {
		if (this.disposed) return { sessionId, tabs: [] }
		const browser = this.browser(sessionId)
		switch (request.kind) {
			case 'state':
				break
			case 'open': {
				const found = resolveAddress(request.path, this.rules(sessionId), { relative: true })
				if (!found.ok) {
					this.refuse(sessionId, found.reason)
					break
				}
				// A page that is already open is read again; a new page takes the tab that has none, else a new tab.
				const same = browser.tabs.find(
					(tab) => tab.owner === 'person' && tab.view.webContents.getURL() === found.url,
				)
				const active = this.activeTab(sessionId)
				const blank =
					active && active.owner === 'person' && !active.view.webContents.getURL()
						? active
						: undefined
				const target = same ?? blank
				if (same) {
					browser.active = same.id
					same.view.webContents.reloadIgnoringCache()
				} else if (target) {
					void target.view.webContents.loadURL(found.url).catch(() => undefined)
				} else this.create(sessionId, found.url)
				browser.notice = undefined
				break
			}
			case 'new':
				this.create(sessionId, request.address)
				break
			case 'go': {
				const found = resolveAddress(request.address, this.rules(sessionId))
				if (!found.ok) {
					this.refuse(sessionId, found.reason)
					break
				}
				const tab = this.activeTab(sessionId) ?? this.create(sessionId)
				if (tab) {
					browser.notice = undefined
					void tab.view.webContents.loadURL(found.url).catch(() => undefined)
				}
				break
			}
			case 'select':
				if (browser.tabs.some((tab) => tab.id === request.tabId)) browser.active = request.tabId
				break
			case 'takeover':
			case 'handback':
				// The same call the relay's own take-over makes; asking twice changes nothing.
				this.setControl(sessionId, request.tabId, request.kind === 'takeover' ? 'person' : 'agent')
				break
			case 'close':
				this.closeTab(sessionId, request.tabId)
				break
			case 'back':
				this.activeTab(sessionId)?.view.webContents.navigationHistory.goBack()
				break
			case 'forward':
				this.activeTab(sessionId)?.view.webContents.navigationHistory.goForward()
				break
			case 'reload':
				this.activeTab(sessionId)?.view.webContents.reload()
				break
			case 'place':
				this.place(sessionId, request.bounds)
				break
			case 'freeze':
				void this.freeze(sessionId)
				break
		}
		// A change of tab changes which page is on screen: put the new one where the old one was.
		if (
			request.kind !== 'place' &&
			request.kind !== 'freeze' &&
			this.placed?.sessionId === sessionId
		)
			this.place(sessionId, this.placed.bounds)
		return this.view(sessionId)
	}

	/** Takes every page off the screen, such as while the app's own page reloads. */
	hide(): void {
		this.detach()
	}

	dispose(): void {
		if (this.disposed) return
		this.detach()
		this.disposed = true
		for (const peers of hostsOfSessions()) peers.delete(this)
		for (const [sessionId, browser] of this.browsers)
			for (const tab of browser.tabs) {
				if (tab.workingTimer) clearTimeout(tab.workingTimer)
				if (tab.owner === 'agent') void this.tell({ kind: 'closed', sessionId, tabId: tab.id })
				try {
					tab.view.webContents.close()
				} catch {
					// The page is already gone.
				}
			}
		this.browsers.clear()
	}
}
