import { type BridgeBackend, PageBridge, type Reply } from './bridge.js'
import { WEBRTC_POLICY, originOf, partitionOf, viewWebPreferences } from './policy.js'
import { type PageInfo, ViewRegistry } from './registry.js'
import { type PageContext, guardContents, hardenSession } from './session.js'
import type { AssetSource, ContentsLike, MakeResponse, SessionLike } from './session.js'

/**
 * One page of one extension in its own native view: its own process, its own in-memory partition, its own
 * origin, and a Namzu-written preload as the only script with any privilege. The renderer only reports
 * where the view should be; it never loads the page. Electron itself is behind `ViewHost`, so what is set
 * on every view is proved with a recording fake.
 */

export interface Bounds {
	x: number
	y: number
	width: number
	height: number
}

export interface PageSpec {
	extensionId: string
	pageId: string
	entry: string
	slot: string
	minHeight?: number
	usesNetwork: boolean
	hosts: readonly string[]
	allow: readonly string[]
	host: readonly ('theme' | 'locale' | 'state' | 'openNamzu')[]
	maxBytes: Readonly<Record<string, number>>
}

export interface ViewContents extends ContentsLike {
	readonly id: number
	readonly mainFrame: unknown
	loadURL(url: string): Promise<void>
	isDestroyed(): boolean
	close(): void
	send(channel: string, ...args: unknown[]): void
	setWebRTCIPHandlingPolicy(policy: string): void
}

export interface NativeView {
	readonly webContents: ViewContents
	setBounds(b: Bounds): void
}

export interface ViewHost {
	/** Make a view with exactly these web preferences, in this partition. */
	createView(prefs: ReturnType<typeof viewWebPreferences>): NativeView
	sessionFor(partition: string): SessionLike
	/** `owner` is the window the page was opened from: it is attached to and detached from that window only. */
	attach(view: NativeView, owner?: unknown): void
	detach(view: NativeView, owner?: unknown): void
	makeResponse: MakeResponse
}

export type PageBackendFactory = (info: PageInfo) => BridgeBackend

export interface OpenedPage {
	readonly info: PageInfo
	readonly bridge: PageBridge
	readonly view: NativeView
	readonly partition: string
	/** The window that opened the page. */
	readonly owner?: unknown
	/** Why the page stopped, once it has. */
	stopped?: 'strikes' | 'crashed' | 'changed' | 'closed'
}

export class ExtensionPages {
	readonly registry = new ViewRegistry()
	private readonly open = new Map<string, OpenedPage>()
	private readonly hardened = new Set<string>()
	/** The rules of the page open in each partition now; the partition's handlers read this, never a copy. */
	private readonly live = new Map<string, PageContext>()
	/**
	 * A generation per page. A caller takes a ticket before it starts asking the engine what to draw; a
	 * close that arrives in the meantime bumps the number, and the late `show` then makes no view.
	 */
	private readonly gen = new Map<string, number>()
	private readonly owners = new Map<string, unknown>()
	/**
	 * The newest rectangle the renderer reported for a page whose view does not exist yet. The engine is
	 * asked what to draw before the view is made, and the slot can change meanwhile (a dialog that covered
	 * it closes): the view must start at that newest rectangle, not the first one, which may be empty.
	 */
	private readonly latest = new Map<string, Bounds>()

	constructor(
		private readonly host: ViewHost,
		private readonly o: {
			preload: string
			now: () => number
			backend: PageBackendFactory
			assetSource: (extensionId: string) => Omit<AssetSource, 'files' | 'onChanged'>
			files: (extensionId: string) => ReturnType<AssetSource['files']>
			audit: (extensionId: string, event: 'ui-closed' | 'ui-file-changed', detail: string) => void
			onStopped: (
				extensionId: string,
				pageId: string,
				reason: NonNullable<OpenedPage['stopped']>,
			) => void
		},
	) {}

	private key = (extensionId: string, pageId: string): string => `${extensionId}\0${pageId}`

	/** Every page that is open and not stopped. */
	all(): OpenedPage[] {
		return [...this.open.values()].filter((p) => !p.stopped)
	}

	get(extensionId: string, pageId: string): OpenedPage | undefined {
		return this.open.get(this.key(extensionId, pageId))
	}

	/** Take a ticket for opening a page; `show` with it opens nothing if the page was closed since. */
	ticket(extensionId: string, pageId: string, owner?: unknown): number {
		const k = this.key(extensionId, pageId)
		this.owners.set(k, owner)
		this.latest.delete(k)
		const n = this.gen.get(k) ?? 0
		this.gen.set(k, n)
		return n
	}

	private bump(k: string): void {
		this.gen.set(k, (this.gen.get(k) ?? 0) + 1)
	}

	/**
	 * Open (or reuse) the page's view and load its entry file from the extension's own origin. Resolves to
	 * undefined, with nothing created, when the page was closed after the ticket was taken.
	 */
	async show(
		spec: PageSpec,
		bounds: Bounds,
		opened: { ticket?: number; owner?: unknown } = {},
	): Promise<OpenedPage | undefined> {
		const k = this.key(spec.extensionId, spec.pageId)
		if (opened.ticket !== undefined && (this.gen.get(k) ?? 0) !== opened.ticket) return undefined
		if (opened.owner !== undefined) {
			this.owners.set(k, opened.owner)
			if (!this.gen.has(k)) this.gen.set(k, 0)
		}
		const kept = this.open.get(k)
		if (kept && !kept.stopped) {
			kept.view.setBounds(this.clamp(bounds))
			return kept
		}
		const origin = originOf(spec.extensionId)
		const partition = partitionOf(spec.extensionId, spec.pageId)
		const ctx: PageContext = {
			extensionId: spec.extensionId,
			origin,
			uiHosts: spec.hosts,
			usesNetwork: spec.usesNetwork,
		}
		// The session is hardened before the first load, and once per partition; every page has its own
		// partition, and the rules it reads are those of the page open in it now.
		this.live.set(partition, ctx)
		if (!this.hardened.has(partition)) {
			this.hardened.add(partition)
			hardenSession(
				this.host.sessionFor(partition),
				() => this.live.get(partition),
				{
					...this.o.assetSource(spec.extensionId),
					files: () => this.o.files(spec.extensionId),
					onChanged: (path) => {
						this.o.audit(spec.extensionId, 'ui-file-changed', path)
						this.stopExtension(spec.extensionId, 'changed')
					},
				},
				this.host.makeResponse,
			)
		}
		const view = this.host.createView(
			viewWebPreferences(partition, this.o.preload, spec.usesNetwork),
		)
		const info: PageInfo = { extensionId: spec.extensionId, pageId: spec.pageId, origin }
		const bridge = new PageBridge({
			allow: spec.allow,
			host: spec.host,
			maxBytes: spec.maxBytes,
			backend: this.o.backend(info),
			now: this.o.now,
			onClose: (reason) => {
				this.o.audit(spec.extensionId, 'ui-closed', 'strikes')
				this.stop(spec.extensionId, spec.pageId, reason)
			},
		})
		const page: OpenedPage = {
			info,
			bridge,
			view,
			partition,
			owner: opened.owner,
		}
		this.open.set(k, page)
		this.registry.register(view.webContents.id, info)
		guardContents(view.webContents, origin)
		// A crash or a hung page closes the view and marks it stopped: one reload per open, never a loop.
		view.webContents.on('render-process-gone', () =>
			this.stop(spec.extensionId, spec.pageId, 'crashed'),
		)
		view.webContents.on('unresponsive', () => this.stop(spec.extensionId, spec.pageId, 'crashed'))
		view.webContents.setWebRTCIPHandlingPolicy(WEBRTC_POLICY)
		view.setBounds(this.clamp(this.latest.get(k) ?? bounds))
		this.latest.delete(k)
		this.host.attach(view, opened.owner)
		await view.webContents.loadURL(`${origin}/${spec.entry}`)
		return page
	}

	/** The slot's rectangle is main's decision: the page cannot make itself larger than the area it is given. */
	private clamp(b: Bounds): Bounds {
		return {
			x: Math.round(b.x),
			y: Math.round(b.y),
			width: Math.max(Math.round(b.width), 0),
			height: Math.max(Math.round(b.height), 0),
		}
	}

	setBounds(extensionId: string, pageId: string, b: Bounds): void {
		const k = this.key(extensionId, pageId)
		const page = this.open.get(k)
		if (page && !page.stopped) page.view.setBounds(this.clamp(b))
		else if (this.gen.has(k)) this.latest.set(k, b)
	}

	stop(extensionId: string, pageId: string, reason: NonNullable<OpenedPage['stopped']>): void {
		const page = this.open.get(this.key(extensionId, pageId))
		if (!page || page.stopped) return
		page.stopped = reason
		this.live.delete(page.partition)
		this.registry.unregister(page.view.webContents.id)
		try {
			this.host.detach(page.view, page.owner)
			if (!page.view.webContents.isDestroyed()) page.view.webContents.close()
		} catch {
			// already gone
		}
		this.o.onStopped(extensionId, pageId, reason)
	}

	/** Stop every open page of one extension (a file changed after it was signed). */
	stopExtension(extensionId: string, reason: NonNullable<OpenedPage['stopped']>): void {
		for (const p of [...this.open.values()])
			if (p.info.extensionId === extensionId) this.stop(extensionId, p.info.pageId, reason)
	}

	close(extensionId: string, pageId: string): void {
		const k = this.key(extensionId, pageId)
		this.bump(k)
		this.latest.delete(k)
		this.stop(extensionId, pageId, 'closed')
		this.open.delete(k)
	}

	closeExtension(extensionId: string): void {
		for (const k of [...this.gen.keys()]) if (k.startsWith(`${extensionId}\0`)) this.bump(k)
		for (const p of [...this.open.values()])
			if (p.info.extensionId === extensionId) this.close(extensionId, p.info.pageId)
	}

	/** Every page a window opened goes with it: the window closed, or its screen was reloaded or crashed. */
	closeOwned(owner: unknown): void {
		for (const [k, who] of [...this.owners]) {
			if (who !== owner) continue
			const [ext = '', page = ''] = k.split('\0')
			this.close(ext, page)
		}
	}

	/** One message from the page's preload: gate it, then answer. A sender that is not a page is dropped. */
	async handleCall(
		event: Parameters<ViewRegistry['check']>[0],
		envelope: unknown,
		activation: boolean,
	): Promise<Reply | undefined> {
		const info = this.registry.check(event)
		if (!info) return undefined
		const page = this.open.get(this.key(info.extensionId, info.pageId))
		if (!page || page.stopped) return undefined
		return page.bridge.handle(envelope, activation === true)
	}
}
