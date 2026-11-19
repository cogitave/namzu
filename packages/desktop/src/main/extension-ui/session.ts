import {
	type RequestContext,
	SCHEME,
	type UiFile,
	navigationAllowed,
	pagePath,
	requestAllowed,
	responseHeaders,
	serveAsset,
	sha256,
} from './policy.js'

/**
 * Hardening of one extension partition, written against small structural types so the rules can be
 * proved with a recording fake: the real thing is Electron's `Session`. Everything is denied first and
 * only what the policy allows is let through; the handlers are in place before the first load.
 */

export interface SessionLike {
	setPermissionRequestHandler(handler: (...args: never[]) => void): void
	setPermissionCheckHandler(handler: (...args: never[]) => boolean): void
	setDevicePermissionHandler(handler: (...args: never[]) => boolean): void
	setDisplayMediaRequestHandler(handler: (...args: never[]) => void): void
	webRequest: {
		onBeforeRequest(
			handler: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void,
		): void
		onHeadersReceived(
			handler: (
				details: { responseHeaders?: Record<string, string[]> },
				cb: (r: { responseHeaders: Record<string, string[]> }) => void,
			) => void,
		): void
	}
	protocol: {
		handle(scheme: string, handler: (request: { url: string }) => Promise<unknown> | unknown): void
	}
}

export interface PageContext extends RequestContext {
	readonly extensionId: string
}

export interface AssetSource {
	/** The files the engine listed for the version this page was opened from, and where they are. */
	files(): { dir: string; files: readonly UiFile[] }
	readonly fs: {
		realpath(path: string): string | undefined
		isRegularFile(path: string): boolean
		read(path: string): Buffer
	}
	readonly path: { join(...parts: string[]): string; sep: string }
	/** A file changed after it was signed: the caller audits `ui-file-changed` and closes the page. */
	onChanged(path: string): void
}

/** Build a `Response`-like answer; Electron's protocol handler wants a real `Response`. */
export type MakeResponse = (
	body: Buffer | null,
	init: { status: number; headers: Record<string, string> },
) => unknown

export function hardenSession(
	session: SessionLike,
	context: PageContext | (() => PageContext | undefined),
	assets: AssetSource,
	makeResponse: MakeResponse,
): void {
	// A getter lets the rules follow the page that is open in this partition now (a later version of
	// the extension may declare other hosts); with none open, nothing is allowed.
	const now = (): PageContext | undefined => (typeof context === 'function' ? context() : context)
	session.setPermissionRequestHandler(((
		_wc: unknown,
		_perm: unknown,
		cb: (allowed: boolean) => void,
	) => cb(false)) as never)
	session.setPermissionCheckHandler((() => false) as never)
	session.setDevicePermissionHandler((() => false) as never)
	session.setDisplayMediaRequestHandler(((_req: unknown, cb: (r: unknown) => void) =>
		cb({})) as never)
	session.webRequest.onBeforeRequest((details, cb) => {
		const ctx = now()
		cb({ cancel: !ctx || !requestAllowed(details.url, ctx) })
	})
	session.webRequest.onHeadersReceived((details, cb) => {
		const ctx = now()
		const hosts = ctx?.usesNetwork ? ctx.uiHosts : []
		const out: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
		for (const [k, v] of Object.entries(responseHeaders(hosts))) {
			// Replace whatever case the response used, so a page's own header cannot loosen the policy.
			for (const existing of Object.keys(out))
				if (existing.toLowerCase() === k.toLowerCase()) delete out[existing]
			out[k] = [v]
		}
		cb({ responseHeaders: out })
	})
	session.protocol.handle(SCHEME, (request) => {
		const ctx = now()
		if (!ctx) return makeResponse(null, { status: 404, headers: {} })
		const path = pagePath(request.url, ctx.origin)
		const { dir, files } = assets.files()
		const a = serveAsset(path, { dir, files, ...assets.fs, ...assets.path }, sha256)
		if (a.status === 200)
			return makeResponse(a.body, {
				status: 200,
				headers: { 'Content-Type': a.mime, ...responseHeaders(ctx.usesNetwork ? ctx.uiHosts : []) },
			})
		if (a.status === 500) assets.onChanged(path ?? '')
		return makeResponse(null, { status: a.status, headers: {} })
	})
}

/** The navigation and window rules of one view's web contents, as a list of handlers to attach. */
export interface ContentsLike {
	setWindowOpenHandler(handler: () => { action: 'deny' }): void
	on(event: string, handler: (event: { preventDefault(): void }, ...args: string[]) => void): void
}

export function guardContents(contents: ContentsLike, origin: string): void {
	contents.setWindowOpenHandler(() => ({ action: 'deny' }))
	for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate'])
		contents.on(ev, (event, url) => {
			if (!navigationAllowed(String(url), origin)) event.preventDefault()
		})
	contents.on('will-attach-webview', (event) => event.preventDefault())
	contents.on('will-download', (event) => event.preventDefault())
}
