/**
 * What `web_fetch` does with a page after the guard has let it through:
 * decide which redirects stay on the same site, turn HTML into markdown, and
 * keep a page for a quarter of an hour so a second question about it does not
 * fetch it again.
 *
 * None of it touches the network or a model. The guard (`guarded-fetch.ts`)
 * decides what may be fetched; this decides what the model is shown.
 */

/** How long a fetched page is kept. */
export const WEB_PAGE_CACHE_TTL_MS = 15 * 60 * 1000
/** Most the cache holds, counted in bytes of page text. */
export const WEB_PAGE_CACHE_MAX_BYTES = 50 * 1024 * 1024
/** Most HTML handed to the converter; the rest is dropped with a marker. */
export const WEB_PAGE_CONVERT_MAX_CHARS = 1024 * 1024
/** Most page text a model is asked about in one call. */
export const WEB_PAGE_MODEL_MAX_CHARS = 100_000
/** Marker the reference-shaped cuts end with. */
export const WEB_PAGE_TRUNCATED_MARKER = '[Content truncated due to length...]'

/**
 * A redirect stays on the site when only the path or query changes (and
 * `www.` comes or goes). `http:` to `https:` on the same host and default
 * port is the same site too: the reference upgrades every URL to `https:`
 * before it asks, so that hop never reaches it.
 */
export function isSameSiteRedirect(from: URL, to: URL): boolean {
	const upgrade = from.protocol === 'http:' && to.protocol === 'https:'
	if (to.protocol !== from.protocol && !upgrade) return false
	if (to.port !== from.port) return false
	if (to.username !== '' || to.password !== '') return false
	const bare = (host: string): string => host.replace(/^www\./u, '')
	return bare(to.hostname) === bare(from.hostname)
}

type Converter = { turndown(html: string): string }
let converter: Promise<Converter> | undefined

function loadConverter(): Promise<Converter> {
	converter ??= import('turndown').then((module) => {
		const Turndown = module.default
		const service = new Turndown()
		service.remove(['style', 'script', 'noscript', 'iframe'])
		return service
	})
	return converter
}

/**
 * HTML as markdown. Style, script, noscript and iframe elements are dropped,
 * and the input is cut at {@link WEB_PAGE_CONVERT_MAX_CHARS}. Never throws: a
 * page the converter cannot read comes back as the HTML it was.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
	try {
		const markdown = (await loadConverter()).turndown(html.slice(0, WEB_PAGE_CONVERT_MAX_CHARS))
		return html.length > WEB_PAGE_CONVERT_MAX_CHARS
			? `${markdown}\n\n${WEB_PAGE_TRUNCATED_MARKER}`
			: markdown
	} catch {
		return html
	}
}

export interface CachedPage {
	readonly content: string
	readonly status: number
	readonly contentType?: string
	/** Where the fetch ended up. */
	readonly url: string
	readonly redirects: readonly string[]
	readonly truncated: boolean
	/** Bytes of text the page held before conversion. */
	readonly bytes: number
}

interface Entry {
	readonly page: CachedPage
	readonly expiresAt: number
	readonly size: number
}

/**
 * Pages by the URL that was asked for, for {@link WEB_PAGE_CACHE_TTL_MS}.
 * Least recently used goes first when the byte cap is reached. The clock is
 * `Date.now`, so a test with fake timers moves it.
 */
export class WebPageCache {
	private readonly entries = new Map<string, Entry>()
	private bytes = 0

	constructor(
		private readonly ttlMs: number = WEB_PAGE_CACHE_TTL_MS,
		private readonly maxBytes: number = WEB_PAGE_CACHE_MAX_BYTES,
	) {}

	get(url: string): CachedPage | undefined {
		const entry = this.entries.get(url)
		if (entry === undefined) return undefined
		if (entry.expiresAt <= Date.now()) {
			this.remove(url)
			return undefined
		}
		// Re-inserted so the map's order is the order of use.
		this.entries.delete(url)
		this.entries.set(url, entry)
		return entry.page
	}

	set(url: string, page: CachedPage): void {
		this.remove(url)
		const size = Math.max(1, Buffer.byteLength(page.content, 'utf8'))
		if (size > this.maxBytes) return
		this.entries.set(url, { page, expiresAt: Date.now() + this.ttlMs, size })
		this.bytes += size
		for (const [oldest, entry] of this.entries) {
			if (this.bytes <= this.maxBytes) break
			this.entries.delete(oldest)
			this.bytes -= entry.size
		}
	}

	private remove(url: string): void {
		const entry = this.entries.get(url)
		if (entry === undefined) return
		this.entries.delete(url)
		this.bytes -= entry.size
	}
}
