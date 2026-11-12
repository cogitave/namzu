import { Readable } from 'node:stream'

/**
 * The platform network stack for the engine feed. `net.fetch` cannot stop at a redirect (it
 * throws "Redirect was cancelled" in manual mode), so a request is made with `net.request`: a
 * redirect is turned into an ordinary 3xx response carrying its address, and the feed's own loop
 * decides whether to go there. No cookies are used or kept.
 */

/** The part of Electron's `net` this uses. */
export interface NetLike {
	request(options: {
		url: string
		method: 'GET'
		redirect: 'manual'
		useSessionCookies: false
	}): NetRequest
}

export interface NetRequest {
	setHeader(name: string, value: string): void
	on(event: 'redirect', listener: (status: number, method: string, url: string) => void): unknown
	on(event: 'response', listener: (response: NetIncoming) => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	end(): void
	abort(): void
}

export interface NetIncoming extends Readable {
	statusCode: number
	headers: Record<string, string | string[] | undefined>
}

export type NetCall = (
	url: string,
	init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>

/** A `Response` per request; a redirect is one with no body and a `location` header. */
export function netCall(net: NetLike, extraHeaders: Record<string, string> = {}): NetCall {
	return (url, init) =>
		new Promise<Response>((resolve, reject) => {
			const request = net.request({
				url,
				method: 'GET',
				redirect: 'manual',
				useSessionCookies: false,
			})
			for (const [name, value] of Object.entries({ ...extraHeaders, ...init.headers }))
				request.setHeader(name, value)
			const stop = () => {
				request.abort()
				reject(new Error('The request was cancelled.'))
			}
			if (init.signal.aborted) {
				stop()
				return
			}
			init.signal.addEventListener('abort', stop, { once: true })
			request.on('redirect', (status, _method, target) => {
				request.abort()
				init.signal.removeEventListener('abort', stop)
				resolve(new Response(null, { status, headers: { location: target } }))
			})
			request.on('response', (incoming) => {
				const headers = new Headers()
				for (const [name, value] of Object.entries(incoming.headers))
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(', ') : value)
				incoming.once('close', () => init.signal.removeEventListener('abort', stop))
				resolve(
					new Response(Readable.toWeb(incoming) as unknown as ReadableStream, {
						status: incoming.statusCode,
						headers,
					}),
				)
			})
			request.on('error', (error) => {
				init.signal.removeEventListener('abort', stop)
				reject(error)
			})
			request.end()
		})
}
