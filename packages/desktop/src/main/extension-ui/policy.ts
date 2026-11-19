import { createHash } from 'node:crypto'

/**
 * What an extension's page may and may not do, as plain data and pure functions so each rule can be
 * proved without Electron. Pages are served from a privileged scheme, each in its own in-memory
 * partition and its own origin; nothing here is inherited from the main window.
 */

export const SCHEME = 'namzu-ext'

/**
 * The origin of an address. Node reads an unknown scheme as an opaque origin (`null`); the page's scheme is
 * registered as a standard one in Chromium, where its origin is the scheme and the host. Both sides use this.
 */
export function urlOrigin(url: string): string {
	const u = new URL(url)
	return u.protocol === `${SCHEME}:` ? `${u.protocol}//${u.host}` : u.origin
}

/** The privileges the scheme is registered with: a normal secure origin, fetch, no service workers, no CSP bypass. */
export const SCHEME_PRIVILEGES = {
	standard: true,
	secure: true,
	supportFetchAPI: true,
	corsEnabled: false,
	bypassCSP: false,
	allowServiceWorkers: false,
} as const

/** `x` and 16 hex digits of the SHA-256 of the extension id: the host part of the page's origin. */
export const extensionHash = (id: string): string =>
	`x${createHash('sha256').update(id).digest('hex').slice(0, 16)}`

export const originOf = (id: string): string => `${SCHEME}://${extensionHash(id)}`

/**
 * In memory only (no `persist:` prefix): nothing a page stores survives its window. Every page of an
 * extension has its own partition, so the network and content rules a page was opened with are its own
 * and never another page's.
 */
export const partitionOf = (id: string, pageId?: string): string =>
	pageId === undefined
		? `namzu-ext-${extensionHash(id).slice(1)}`
		: `namzu-ext-${extensionHash(id).slice(1)}-${createHash('sha256').update(`${id}\0${pageId}`).digest('hex').slice(0, 12)}`

/** The exact content policy a page gets; a page cannot loosen it. Hosts are only those declared for `ui`. */
export function contentPolicy(uiHosts: readonly string[] = []): string {
	const connect = ["'self'", ...uiHosts.map((h) => `https://${h}`)].join(' ')
	return [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"media-src 'none'",
		"object-src 'none'",
		"frame-src 'none'",
		"worker-src 'none'",
		"child-src 'none'",
		"manifest-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		`connect-src ${connect}`,
	].join('; ')
}

export const PERMISSIONS_POLICY = [
	'camera=()',
	'microphone=()',
	'geolocation=()',
	'display-capture=()',
	'clipboard-read=()',
	'clipboard-write=()',
	'payment=()',
	'usb=()',
	'serial=()',
	'hid=()',
	'fullscreen=()',
].join(', ')

/** The headers added to every response a page gets (`webRequest.onHeadersReceived`). */
export function responseHeaders(uiHosts: readonly string[] = []): Record<string, string> {
	return {
		'Content-Security-Policy': contentPolicy(uiHosts),
		'Permissions-Policy': PERMISSIONS_POLICY,
		'X-Content-Type-Options': 'nosniff',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Referrer-Policy': 'no-referrer',
	}
}

/**
 * WebRTC is outside the request rules and the content policy, so it is held to proxied traffic only
 * on every page's contents (`webContents.setWebRTCIPHandlingPolicy`), whether or not it declared a network.
 */
export const WEBRTC_POLICY = 'disable_non_proxied_udp'

/**
 * The switch Namzu's own page preload reads (from the process arguments, which a page cannot see): a page
 * that declared no network has the peer-connection constructors removed from its main world before any of
 * its script runs. The IP policy above only narrows WebRTC; this closes it.
 */
export const NO_NETWORK_ARG = '--namzu-ext-no-network=1'

/** `webPreferences` of a page's view, each written out; none inherited from the main window. */
export function viewWebPreferences(partition: string, preload: string, usesNetwork = false) {
	return {
		additionalArguments: usesNetwork ? ([] as string[]) : [NO_NETWORK_ARG],
		sandbox: true,
		contextIsolation: true,
		nodeIntegration: false,
		nodeIntegrationInWorker: false,
		nodeIntegrationInSubFrames: false,
		webSecurity: true,
		allowRunningInsecureContent: false,
		experimentalFeatures: false,
		webviewTag: false,
		plugins: false,
		navigateOnDragDrop: false,
		spellcheck: false,
		enableWebSQL: false,
		safeDialogs: true,
		backgroundThrottling: true,
		autoplayPolicy: 'document-user-activation-required',
		partition,
		preload,
	} as const
}

export interface RequestContext {
	readonly origin: string
	/** Hosts declared for the page's own network use (`for: ui`), and only when the page has `usesNetwork`. */
	readonly uiHosts: readonly string[]
	readonly usesNetwork: boolean
}

/**
 * `webRequest.onBeforeRequest`: only the page's own origin, `data:` and `blob:` images and fonts, and
 * `https://<host>` for hosts declared for the page when it has `usesNetwork`. Everything else is
 * cancelled: `file:`, `ws:`, other extensions' origins, Namzu's own scheme, `devtools:`, `javascript:`.
 */
export function requestAllowed(url: string, ctx: RequestContext): boolean {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return false
	}
	if (u.protocol === `${SCHEME}:`) return urlOrigin(url) === ctx.origin
	if (u.protocol === 'data:' || u.protocol === 'blob:') return true
	if (u.protocol === 'https:')
		return ctx.usesNetwork && u.port === '' && ctx.uiHosts.includes(u.hostname)
	return false
}

/** `will-navigate`, `will-redirect` and `will-frame-navigate`: the page's own origin only. */
export function navigationAllowed(url: string, origin: string): boolean {
	try {
		return urlOrigin(url) === origin
	} catch {
		return false
	}
}

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	woff2: 'font/woff2',
	woff: 'font/woff',
	txt: 'text/plain; charset=utf-8',
}

export const mimeOf = (path: string): string | undefined =>
	MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]

export interface UiFile {
	readonly path: string
	readonly sha256: string
}

export type AssetAnswer =
	| { status: 200; body: Buffer; mime: string }
	| { status: 404 }
	| { status: 500; reason: 'ui-file-changed' }

export interface AssetDeps {
	/** The folder of the verified version. */
	readonly dir: string
	/** The files the engine listed for this version, with the hash each was signed with. */
	readonly files: readonly UiFile[]
	/** The real path of a file, or undefined when it does not exist. */
	readonly realpath: (path: string) => string | undefined
	/** Whether the path is a regular file (not a link, a folder or a device). */
	readonly isRegularFile: (path: string) => boolean
	readonly read: (path: string) => Buffer
	readonly join: (...parts: string[]) => string
	readonly sep: string
}

/** The pathname a request names, refused when it could name anything but a plain package path. */
export function pagePath(url: string, origin: string): string | undefined {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return undefined
	}
	if (urlOrigin(url) !== origin) return undefined
	// The address parser folds `..` and `%2e%2e` away, so the text as it arrived is looked at first: a request
	// that tried any of these is refused, not quietly turned into another path.
	const rest = url.slice(origin.length).split(/[?#]/, 1)[0] ?? ''
	if (/%2e|%2f|%5c|%00|\\|\0|:/i.test(rest) || rest.startsWith('//')) return undefined
	if (rest.split('/').some((seg) => seg === '..' || seg === '.')) return undefined
	const path = u.pathname.replace(/^\//, '')
	return path === '' ? undefined : path
}

/**
 * Serve a file only when its path is in the list the engine returned for this version, is under `ui/`
 * (or is a named icon), resolves inside the version folder, is a regular file, and its bytes hash to the
 * listed value at read time. A mismatch answers 500 and is for the caller to audit and close the page.
 */
export function serveAsset(
	path: string | undefined,
	d: AssetDeps,
	hash: (b: Buffer) => string,
): AssetAnswer {
	if (!path) return { status: 404 }
	const listed = d.files.find((f) => f.path === path)
	if (!listed) return { status: 404 }
	const mime = mimeOf(path)
	if (!mime) return { status: 404 }
	const abs = d.join(d.dir, ...path.split('/'))
	const real = d.realpath(abs)
	const root = d.realpath(d.dir)
	if (!real || !root) return { status: 404 }
	if (real !== abs || (real !== root && !real.startsWith(root + d.sep))) return { status: 404 }
	if (!d.isRegularFile(real)) return { status: 404 }
	const body = d.read(real)
	if (hash(body) !== listed.sha256) return { status: 500, reason: 'ui-file-changed' }
	return { status: 200, body, mime }
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
