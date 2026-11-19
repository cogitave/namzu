import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { type BrowserWindow, WebContentsView, app, ipcMain, protocol, session } from 'electron'
import type { ExtensionPageEvent, PageBounds } from '../../shared/extension-ui.js'
import { SCHEME, SCHEME_PRIVILEGES } from './policy.js'
import type { PageInfo } from './registry.js'
import {
	type BackendDeps,
	type EngineCall,
	type UiInfo,
	pageBackend,
	pageSpec,
	readUiInfo,
} from './service.js'
import { ExtensionPages, type NativeView, type ViewContents, type ViewHost } from './view.js'
import { watchWindow } from './window-guard.js'

/**
 * The Electron side of extension pages. Everything decided here is decided by `policy`, `bridge`, `session`
 * and `view`, which are tested without Electron; this file only gives them real windows, sessions and IPC.
 */

/** Must be called before the app is ready: the scheme a page is served from. */
export function registerExtensionScheme(): void {
	protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { ...SCHEME_PRIVILEGES } }])
}

interface Native extends NativeView {
	readonly native: WebContentsView
}

export interface ExtensionUiDeps {
	readonly preloadPath: string
	readonly engine: EngineCall
	readonly locale: () => string
	/** Tell every window something about a page (stopped, or Namzu is asked to open one of its own screens). */
	readonly emit: (event: ExtensionPageEvent) => void
	readonly audit: (
		extensionId: string,
		event: 'ui-closed' | 'ui-file-changed',
		detail: string,
	) => void
}

export class ExtensionUiService {
	private readonly infos = new Map<string, UiInfo>()
	private readonly states = new Map<string, string>()
	private theme: { dark: boolean; tokens: Record<string, string> } = { dark: false, tokens: {} }
	private readonly watched = new WeakSet<BrowserWindow>()
	private creating = false
	readonly pages: ExtensionPages

	constructor(private readonly d: ExtensionUiDeps) {
		const host: ViewHost = {
			createView: (prefs) => {
				this.creating = true
				try {
					const native = new WebContentsView({ webPreferences: { ...prefs } })
					const c = native.webContents
					const contents: ViewContents = {
						get id() {
							return c.id
						},
						get mainFrame() {
							return c.mainFrame
						},
						loadURL: (url) => c.loadURL(url),
						isDestroyed: () => c.isDestroyed(),
						close: () => c.close(),
						send: (channel, ...args) => c.send(channel, ...args),
						setWebRTCIPHandlingPolicy: (policy) =>
							c.setWebRTCIPHandlingPolicy(policy as 'disable_non_proxied_udp'),
						setWindowOpenHandler: (h) => c.setWindowOpenHandler(h),
						on: (event, h) =>
							(c as unknown as { on(e: string, f: (...a: unknown[]) => void): void }).on(
								event,
								(...a: unknown[]) => {
									// Electron puts the event first and the address after it.
									h(a[0] as { preventDefault(): void }, ...(a.slice(1).map(String) as string[]))
								},
							),
					}
					c.on('did-finish-load', () => this.pushTheme(c.id))
					// Escape inside the page leaves it, like Escape anywhere else in the window.
					c.on('before-input-event', (_event: unknown, input: unknown) => {
						const key = input as { type?: string; key?: string }
						if (key.type === 'keyDown' && key.key === 'Escape') d.emit({ what: 'escape' })
					})
					const view: Native = {
						native,
						webContents: contents,
						setBounds: (b) => native.setBounds(b),
					}
					return view
				} finally {
					this.creating = false
				}
			},
			sessionFor: (partition) => session.fromPartition(partition) as never,
			// A view is attached to, and detached from, the window that opened its page, never another one.
			attach: (v, owner) => (owner as BrowserWindow).contentView.addChildView((v as Native).native),
			detach: (v, owner) => {
				try {
					const w = owner as BrowserWindow | undefined
					if (w && !w.isDestroyed()) w.contentView.removeChildView((v as Native).native)
				} catch {
					// already removed with its window
				}
			},
			makeResponse: (body, init) =>
				new Response(body ? new Uint8Array(body) : null, {
					status: init.status,
					headers: init.headers,
				}),
		}
		this.pages = new ExtensionPages(host, {
			preload: d.preloadPath,
			now: () => Date.now(),
			backend: (info: PageInfo) => pageBackend(this.backendDeps(), info),
			assetSource: () => ({
				fs: {
					realpath: (p) => {
						try {
							return realpathSync(p)
						} catch {
							return undefined
						}
					},
					isRegularFile: (p) => {
						try {
							return statSync(p).isFile()
						} catch {
							return false
						}
					},
					read: (p) => readFileSync(p),
				},
				path: { join, sep },
			}),
			files: (id) => {
				const i = this.infos.get(id)
				return { dir: i?.dir ?? '', files: i?.files ?? [] }
			},
			audit: (id, event, detail) => d.audit(id, event, detail),
			onStopped: (extensionId, pageId, reason) =>
				d.emit({ what: 'stopped', extensionId, pageId, reason }),
		})
		// Defence in depth: whatever creates web contents later, an extension view never gets a webview,
		// a new window, a navigation away or a download from a code path added after these rules.
		app.on('web-contents-created', (_e, contents) => {
			if (!this.creating) return
			contents.setWindowOpenHandler(() => ({ action: 'deny' }))
			contents.on('will-attach-webview', (e) => e.preventDefault())
		})
		ipcMain.handle('namzu-ext:call', async (event, envelope: unknown) => {
			const activation = (envelope as { a?: unknown } | null)?.a === true
			return this.pages.handleCall(
				{ sender: event.sender, senderFrame: event.senderFrame },
				envelope,
				activation,
			)
		})
	}

	private backendDeps(): BackendDeps {
		return {
			engine: this.d.engine,
			theme: (id) => this.themeFor(id),
			locale: () => this.d.locale(),
			state: (id) => this.states.get(id),
			openNamzu: (info, target) =>
				this.d.emit({ what: 'open-namzu', extensionId: info.extensionId, target }),
		}
	}

	private send(webContentsId: number, ev: string, data: unknown): void {
		for (const p of this.pages.all()) {
			if (p.view.webContents.id === webContentsId && !p.stopped)
				p.view.webContents.send('namzu-ext:event', { v: 1, ev, d: data })
		}
	}

	/** Namzu's tokens plus this extension's own accent, which is the only colour that is the extension's. */
	private themeFor(extensionId: string): { dark: boolean; tokens: Record<string, string> } {
		const accent = this.infos.get(extensionId)?.accent
		return {
			dark: this.theme.dark,
			tokens: { ...this.theme.tokens, ...(accent ? { '--ns-accent': accent } : {}) },
		}
	}

	private pushTheme(webContentsId: number): void {
		const page = this.pages.all().find((p) => p.view.webContents.id === webContentsId)
		if (page) this.send(webContentsId, 'theme', this.themeFor(page.info.extensionId))
	}

	setTheme(dark: boolean, tokens: Record<string, string>): void {
		this.theme = { dark, tokens }
		for (const p of this.pages.all()) this.pushTheme(p.view.webContents.id)
	}

	/** The engine's state words, kept so `host:state` can answer at once; pages are told when one changes. */
	stateChanged(extensionId: string, state: string): void {
		this.states.set(extensionId, state)
		for (const p of this.pages.all())
			if (p.info.extensionId === extensionId) this.send(p.view.webContents.id, 'state', { state })
	}

	/** Ask the engine what to draw, then show the page in the slot the renderer measured. */
	async show(
		window: BrowserWindow,
		extensionId: string,
		pageId: string,
		bounds: PageBounds,
	): Promise<{ ok: boolean; reason?: string }> {
		this.watch(window)
		// The ticket is taken before the engine is asked: a close that arrives while it answers wins.
		const ticket = this.pages.ticket(extensionId, pageId, window)
		const raw = await this.d.engine('namzu/extensions/ui', { id: extensionId })
		const info = readUiInfo(raw)
		if (!info) return { ok: false, reason: 'no-ui' }
		this.infos.set(extensionId, info)
		const spec = pageSpec(extensionId, info, pageId)
		if (!spec) return { ok: false, reason: 'no-page' }
		const page = await this.pages.show(spec, bounds, { ticket, owner: window })
		if (!page) return { ok: false, reason: 'closed' }
		return page.stopped ? { ok: false, reason: page.stopped } : { ok: true }
	}

	/** Once per window: its pages end with it, and with a reload or a crash of its screen. */
	private watch(window: BrowserWindow): void {
		if (this.watched.has(window)) return
		this.watched.add(window)
		watchWindow(window, () => this.pages.closeOwned(window))
	}

	setBounds(extensionId: string, pageId: string, bounds: PageBounds): void {
		this.pages.setBounds(extensionId, pageId, bounds)
	}

	close(extensionId: string, pageId: string): void {
		this.pages.close(extensionId, pageId)
	}

	/** An extension was disabled or removed: its pages go with it. */
	closeExtension(extensionId: string): void {
		this.pages.closeExtension(extensionId)
		this.infos.delete(extensionId)
	}
}
