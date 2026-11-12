import type { FeedFetch } from './check.js'
import { isAllowedFeedUrl } from './keys.js'

/**
 * Turns a `fetch` into the check's `FeedFetch`: the headers are exactly the ones the check
 * names (nothing about the person or the machine, and no cookies), redirects are followed one hop
 * at a time and every address is checked before it is requested, so a redirect to somewhere the
 * feed must not go is never sent a request, and a transfer that goes quiet is cut off.
 */

/** The part of a `fetch` response this reads; the platform's `Response` satisfies it. */
export interface FetchedResponse {
	status: number
	url?: string
	/** Where a redirect points, when the response is one. */
	location?: string | null
	body: AsyncIterable<Uint8Array> | null
}

export type FetchLike = (
	url: string,
	init: {
		headers: Record<string, string>
		redirect: 'manual'
		credentials: 'omit'
		signal: AbortSignal
	},
) => Promise<FetchedResponse>

export interface FeedFetchOptions {
	fetch: FetchLike
	/** Runs `run` once after `ms`, unless the returned function is called first. */
	after: (ms: number, run: () => void) => () => void
	/** How long a transfer may make no progress. */
	stallMs?: number
}

export const STALL_MS = 30_000
export const MAX_REDIRECTS = 5
const REDIRECT = new Set([301, 302, 303, 307, 308])

export function createFeedFetch(options: FeedFetchOptions): FeedFetch {
	const stallMs = options.stallMs ?? STALL_MS
	return async (url, init) => {
		const controller = new AbortController()
		const outer = init.signal
		const onAbort = () => controller.abort()
		if (outer?.aborted) controller.abort()
		else outer?.addEventListener('abort', onAbort, { once: true })
		let cancel = options.after(stallMs, () => controller.abort())
		const rearm = () => {
			cancel()
			cancel = options.after(stallMs, () => controller.abort())
		}
		const done = () => {
			cancel()
			outer?.removeEventListener('abort', onAbort)
		}
		let response: FetchedResponse
		let at = url
		try {
			for (let hop = 0; ; hop++) {
				response = await options.fetch(at, {
					headers: { ...init.headers },
					redirect: 'manual',
					credentials: 'omit',
					signal: controller.signal,
				})
				if (!REDIRECT.has(response.status)) break
				await discard(response.body)
				if (!response.location) throw new Error('A redirect named no address.')
				if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.')
				const next = new URL(response.location, at).href
				if (!isAllowedFeedUrl(next))
					throw new Error('The update address sent the request somewhere that is not allowed.')
				at = next
			}
		} catch (error) {
			done()
			throw error
		}
		const body = response.body
		if (!body) {
			done()
			return { status: response.status, body: null, url: at }
		}
		async function* guarded(): AsyncGenerator<Uint8Array> {
			try {
				for await (const chunk of body as AsyncIterable<Uint8Array>) {
					rearm()
					yield chunk
				}
			} finally {
				done()
			}
		}
		return { status: response.status, body: guarded(), url: at }
	}
}

/** A redirect's body is not wanted; releasing it frees the connection. */
async function discard(body: AsyncIterable<Uint8Array> | null): Promise<void> {
	try {
		await body?.[Symbol.asyncIterator]().return?.()
	} catch {
		// nothing to release
	}
}
