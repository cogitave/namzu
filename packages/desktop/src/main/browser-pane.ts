import { createHash, randomUUID } from 'node:crypto'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import {
	type BrowserBounds,
	type BrowserPaneRequest,
	type BrowserPaneState,
	type BrowserTabView,
	MAX_BROWSER_TABS,
} from '../shared/browser-pane.js'
import type { BrowserCookieScope } from '../shared/settings-protocol.js'
import { type AddressRules, addressText, fileAllowed, resolveAddress } from './browser-address.js'

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
 */

const MAX_TABS = MAX_BROWSER_TABS

type View = WebContentsView
interface Tab {
	id: string
	view: View
	title: string
	loading: boolean
}
interface Browser {
	tabs: Tab[]
	active?: string
	notice?: string
	/** The picture standing in for the page while something lies over it. */
	still?: string
}

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

/** One window's browser pages, kept per conversation. */
export class BrowserPaneHost {
	private readonly browsers = new Map<string, Browser>()
	private readonly guarded = new Set<string>()
	private attached: { sessionId: string; tab: Tab } | undefined
	/** Where the renderer last asked for the page, so a tab that changes is put there at once. */
	private placed: { sessionId: string; bounds: BrowserBounds } | undefined
	private disposed = false
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

	/** The conversation a request came from: a partition can be shared, so the page's own tab says. */
	private sessionOfContents(webContentsId: number | undefined): string | undefined {
		if (webContentsId === undefined) return undefined
		for (const [sessionId, browser] of this.browsers)
			if (browser.tabs.some((tab) => tab.view.webContents.id === webContentsId)) return sessionId
		return undefined
	}

	/** Shuts a partition's doors once: permissions, downloads and files outside the work folder. */
	private guard(sessionId: string): string {
		const partition = partitionOf(this.deps.cookieScope(), sessionId)
		if (this.guarded.has(partition)) return partition
		this.guarded.add(partition)
		const ses = this.deps.sessionOf(partition)
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
		ses.setPermissionCheckHandler(() => false)
		ses.setDevicePermissionHandler(() => false)
		ses.on('will-download', (event) => event.preventDefault())
		ses.webRequest.onBeforeRequest((details, callback) => {
			// A shared partition serves many conversations: a file is judged by the work folder of the
			// conversation whose tab asked, and a request from no known tab may load no file.
			const owner = this.sessionOfContents(details.webContentsId)
			const blocked =
				details.url.startsWith('file:') &&
				(owner === undefined || !fileAllowed(details.url, this.rules(owner)))
			callback({ cancel: blocked })
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
			}
		}
		contents.on('will-navigate', (event, url) => guardNavigation(event, url))
		contents.on('will-redirect', (event, url) => guardNavigation(event, url))
		// A page that asks for a window gets a tab in this pane, never a window.
		contents.setWindowOpenHandler(({ url }) => {
			this.create(sessionId, url)
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
		if (browser.tabs.length >= MAX_TABS) {
			this.refuse(sessionId, 'Close a tab before opening another.')
			return undefined
		}
		const view = this.deps.createView(this.guard(sessionId))
		const tab: Tab = { id: randomUUID(), view, title: '', loading: false }
		browser.tabs.push(tab)
		browser.active = tab.id
		browser.notice = undefined
		this.watch(sessionId, tab)
		if (found?.ok) void view.webContents.loadURL(found.url).catch(() => undefined)
		this.emit(sessionId)
		return tab
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
			this.deps.window.contentView.addChildView(tab.view)
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
		if (this.attached?.tab === tab) this.detach()
		browser.tabs.splice(at, 1)
		if (browser.active === tabId) browser.active = (browser.tabs[at] ?? browser.tabs[at - 1])?.id
		tab.view.webContents.close()
		this.emit(sessionId)
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
				const same = browser.tabs.find((tab) => tab.view.webContents.getURL() === found.url)
				const active = this.activeTab(sessionId)
				const blank = active && !active.view.webContents.getURL() ? active : undefined
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
		for (const browser of this.browsers.values())
			for (const tab of browser.tabs) {
				try {
					tab.view.webContents.close()
				} catch {
					// The page is already gone.
				}
			}
		this.browsers.clear()
	}
}
