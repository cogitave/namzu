import type { FeedFetch } from './check.js'

/**
 * Turns a `fetch` into the check's `FeedFetch`: the headers are exactly the ones the check
 * names (nothing about the person or the machine), redirects are followed and the final address
 * is reported so the check can refuse a redirect to somewhere it must not go, and a transfer
 * that goes quiet is cut off.
 */

/** The part of a `fetch` response this reads; the platform's `Response` satisfies it. */
export interface FetchedResponse {
	status: number
	url?: string
	body: AsyncIterable<Uint8Array> | null
}

export type FetchLike = (
	url: string,
	init: { headers: Record<string, string>; redirect: 'follow'; signal: AbortSignal },
) => Promise<FetchedResponse>

export interface FeedFetchOptions {
	fetch: FetchLike
	/** Runs `run` once after `ms`, unless the returned function is called first. */
	after: (ms: number, run: () => void) => () => void
	/** How long a transfer may make no progress. */
	stallMs?: number
}

export const STALL_MS = 30_000

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
		try {
			response = await options.fetch(url, {
				headers: { ...init.headers },
				redirect: 'follow',
				signal: controller.signal,
			})
		} catch (error) {
			done()
			throw error
		}
		const body = response.body
		if (!body) {
			done()
			return { status: response.status, body: null, ...(response.url ? { url: response.url } : {}) }
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
		return {
			status: response.status,
			body: guarded(),
			...(response.url ? { url: response.url } : {}),
		}
	}
}
