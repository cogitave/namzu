/**
 * Reaching the web, as a seam rather than as a bundled vendor.
 *
 * Two providers, and they are separated on purpose. **Fetching a URL is a
 * capability this kernel can implement**: the rules are about the network
 * and the same everywhere, so a wrong answer is a defect rather than a
 * preference. **Searching is not.** Every search backend has its own
 * account, its own terms, its own result shape and its own opinion about
 * what a result even is, and picking one here would make that choice for
 * every consumer while adding a dependency nobody asked for.
 *
 * So `WebFetchProvider` ships with a guarded implementation and
 * `WebSearchProvider` ships with none. A host that wants search brings one.
 * That asymmetry is the design, not an omission — see
 * `GuardedFetchProvider` for what "guarded" is doing the work of.
 */

export interface WebFetchRequest {
	readonly url: string
	/** Extra headers. The provider may refuse or strip some; see the guard. */
	readonly headers?: Readonly<Record<string, string>>
	readonly signal?: AbortSignal
}

export interface WebFetchResult {
	readonly url: string
	readonly status: number
	readonly contentType?: string
	readonly body: string
	/**
	 * Whether the body was cut off at the size cap.
	 *
	 * Reported, never silent. A truncated page that reads as complete is a
	 * model concluding something from a document whose second half it never
	 * saw — the same rule the tool-output cap and the background job buffer
	 * already follow.
	 */
	readonly truncated: boolean
	/** Every URL in the redirect chain, in order, including the final one. */
	readonly redirects: readonly string[]
}

/** Why a fetch was refused before it left the process. */
export type WebFetchRefusalReason =
	| 'scheme'
	| 'private-address'
	| 'redirect-limit'
	| 'redirect-target'
	| 'blocked-host'

export class WebFetchRefusedError extends Error {
	readonly details: { url: string; reason: WebFetchRefusalReason }

	constructor(message: string, details: { url: string; reason: WebFetchRefusalReason }) {
		super(message)
		this.name = 'WebFetchRefusedError'
		this.details = details
	}
}

export interface WebFetchProvider {
	fetch(request: WebFetchRequest): Promise<WebFetchResult>
}

export interface WebSearchRequest {
	readonly query: string
	readonly limit?: number
	readonly signal?: AbortSignal
}

export interface WebSearchHit {
	readonly title: string
	readonly url: string
	/**
	 * The backend's own excerpt, when it has one.
	 *
	 * Not synthesised here. A snippet this kernel wrote would be a claim
	 * about a page nobody fetched, and a model citing it would be citing us.
	 */
	readonly snippet?: string
}

export interface WebSearchResult {
	readonly query: string
	readonly hits: readonly WebSearchHit[]
}

/**
 * Search, which this kernel does NOT implement.
 *
 * Declared so the tool surface and the wiring can exist without a vendor,
 * and so a host's backend has a shape to satisfy rather than a convention
 * to guess at. There is deliberately no default: a search provider means an
 * account, terms of service, and a result shape, and choosing one here
 * would choose it for every consumer.
 */
export interface WebSearchProvider {
	search(request: WebSearchRequest): Promise<WebSearchResult>
}
