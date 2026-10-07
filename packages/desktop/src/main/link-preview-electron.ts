import { net, type Session, app } from 'electron'
import type { LinkPreviewNetwork, LinkPreviewResponse } from './link-preview.js'

/** Chunks wait here until the reader asks; the reader stops at a byte cap. */
function bodyQueue() {
	const chunks: Uint8Array[] = []
	let done = false
	let failure: unknown
	let wake: (() => void) | undefined
	const notify = () => {
		const resume = wake
		wake = undefined
		resume?.()
	}
	return {
		push(chunk: Uint8Array) {
			if (done) return
			chunks.push(chunk)
			notify()
		},
		end() {
			done = true
			notify()
		},
		fail(error: unknown) {
			if (done) return
			failure = error
			done = true
			notify()
		},
		iterable: {
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				for (;;) {
					const next = chunks.shift()
					if (next) {
						yield next
						continue
					}
					if (failure !== undefined) throw failure
					if (done) return
					await new Promise<void>((resolve) => {
						wake = resolve
					})
				}
			},
		} satisfies AsyncIterable<Uint8Array>,
	}
}

const aborted = () => new Error('aborted')

/**
 * Previews use their own in-memory session: no cookies, cache or sign-in from
 * the app's profile can reach a page the model named.
 */
export function electronLinkPreviewNetwork(ses: Session): LinkPreviewNetwork {
	return {
		async resolve(hostname) {
			const resolved = await ses.resolveHost(hostname)
			return resolved.endpoints.map((endpoint) => endpoint.address)
		},
		request(url, accept, signal) {
			return new Promise<LinkPreviewResponse>((resolve, reject) => {
				if (signal.aborted) return reject(aborted())
				const request = net.request({
					url,
					session: ses,
					method: 'GET',
					credentials: 'omit',
					useSessionCookies: false,
					redirect: 'manual',
					cache: 'no-store',
				})
				request.setHeader('Accept', accept)
				request.setHeader('Accept-Language', app.getLocale() || 'en')
				const queue = bodyQueue()
				let settled = false
				const stop = () => {
					signal.removeEventListener('abort', onAbort)
					request.abort()
				}
				const onAbort = () => {
					stop()
					queue.fail(aborted())
					if (!settled) {
						settled = true
						reject(aborted())
					}
				}
				signal.addEventListener('abort', onAbort, { once: true })
				request.on('redirect', (status, _method, redirectUrl) => {
					if (settled) return
					settled = true
					// Never follow: the caller re-validates the target first.
					stop()
					queue.end()
					resolve({
						status,
						location: redirectUrl,
						header: () => undefined,
						body: queue.iterable,
						cancel() {},
					})
				})
				request.on('response', (response) => {
					if (settled) return
					settled = true
					response.on('data', (chunk) => queue.push(new Uint8Array(chunk)))
					response.on('end', () => {
						signal.removeEventListener('abort', onAbort)
						queue.end()
					})
					response.on('error', () => queue.fail(aborted()))
					response.on('aborted', () => queue.fail(aborted()))
					resolve({
						status: response.statusCode,
						header(name) {
							const value = response.headers[name.toLowerCase()]
							return Array.isArray(value) ? value.join(', ') : value
						},
						body: queue.iterable,
						cancel() {
							stop()
							queue.end()
						},
					})
				})
				request.on('error', () => {
					queue.fail(aborted())
					if (!settled) {
						settled = true
						reject(aborted())
					}
				})
				request.end()
			})
		},
	}
}
