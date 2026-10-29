/**
 * An HTTP hook: the event as a JSON POST, the response as the hook's answer.
 *
 * A 2xx response is exit `0` with the body as stdout, so the JSON answer is
 * read exactly as a command's is. Any other status, a network error and a
 * deadline are the hook's own failure. The address is checked where the
 * connection is made, not before it: a name that resolves to a private or
 * link-local address (a cloud metadata service, a router) is refused, so a
 * hook cannot be pointed at the machine's neighbours and a name cannot be
 * re-resolved between the check and the connect. Loopback stays allowed for
 * local development. Redirects are not followed.
 */

import { type LookupAddress, lookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

/** Captured response bound. */
const MAX_BODY_BYTES = 64 * 1024

export interface HttpHookRequest {
	readonly url: string
	readonly body: string
	readonly headers?: Readonly<Record<string, string>> | undefined
	readonly allowedEnvVars?: readonly string[] | undefined
	readonly timeoutMs: number
	readonly env?: Readonly<Record<string, string | undefined>> | undefined
	readonly signal?: AbortSignal | undefined
}

export interface HttpHookResponse {
	readonly status: number | null
	readonly body: string
	readonly timedOut: boolean
	readonly error?: string
}

/**
 * Replace `$NAME` and `${NAME}` in a header value with the environment's
 * value, but only for names the hook listed. Any other reference becomes the
 * empty string, so a header can never carry a variable its author did not
 * name. Line breaks and NUL are removed from the result, so a value cannot add
 * a header of its own.
 */
export function interpolateHookHeader(
	value: string,
	allowed: ReadonlySet<string>,
	env: Readonly<Record<string, string | undefined>>,
): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced, bare) => {
			const name = (braced ?? bare) as string
			return allowed.has(name) ? (env[name] ?? '') : ''
		})
		.replace(/[\r\n\0]/g, '')
}

/** Whether an address may be connected to: public, or loopback. */
export function isReachableHookAddress(address: string): boolean {
	const family = isIP(address)
	if (family === 4) {
		const [a = 0, b = 0] = address.split('.').map(Number)
		if (a === 127) return true
		if (a === 0 || a === 10) return false
		if (a === 169 && b === 254) return false
		if (a === 172 && b >= 16 && b <= 31) return false
		if (a === 192 && b === 168) return false
		if (a === 100 && b >= 64 && b <= 127) return false
		if (a >= 224) return false
		return true
	}
	if (family === 6) {
		const lower = address.toLowerCase()
		if (lower === '::1') return true
		if (lower === '::') return false
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
		if (mapped?.[1]) return isReachableHookAddress(mapped[1])
		if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return false
		return true
	}
	return false
}

/** `dns.lookup` that refuses an address a hook may not reach. */
function guardedLookup(
	hostname: string,
	options: { all?: boolean; family?: number | 'IPv4' | 'IPv6' },
	callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
): void {
	lookup(hostname, { ...options, all: true }, (error: Error | null, addresses: LookupAddress[]) => {
		if (error) {
			callback(error)
			return
		}
		const list = addresses
		const refused = list.find((entry) => !isReachableHookAddress(entry.address))
		if (refused || list.length === 0) {
			callback(
				new Error(
					`${hostname} resolves to ${refused?.address ?? 'nothing'}, a private or link-local address`,
				),
			)
			return
		}
		if (options.all) {
			callback(null, list)
			return
		}
		const first = list[0] as LookupAddress
		callback(null, first.address, first.family)
	})
}

export function postHookJson(input: HttpHookRequest): Promise<HttpHookResponse> {
	return new Promise((resolve) => {
		let url: URL
		try {
			url = new URL(input.url)
		} catch {
			resolve({ status: null, body: '', timedOut: false, error: 'the url is not valid' })
			return
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			resolve({ status: null, body: '', timedOut: false, error: 'the url must be http or https' })
			return
		}
		// A literal address never reaches the resolver, so it is checked here.
		const literal = url.hostname.replace(/^\[|\]$/g, '')
		if (isIP(literal) !== 0 && !isReachableHookAddress(literal)) {
			resolve({
				status: null,
				body: '',
				timedOut: false,
				error: `${literal} is a private or link-local address`,
			})
			return
		}
		const allowed = new Set(input.allowedEnvVars ?? [])
		const env = input.env ?? process.env
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Content-Length': String(Buffer.byteLength(input.body)),
		}
		for (const [name, value] of Object.entries(input.headers ?? {})) {
			headers[name] = interpolateHookHeader(value, allowed, env)
		}
		let settled = false
		let timedOut = false
		const finish = (response: HttpHookResponse) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			input.signal?.removeEventListener('abort', onAbort)
			resolve(response)
		}
		const onAbort = () => {
			req.destroy()
			finish({ status: null, body: '', timedOut: false, error: 'cancelled' })
		}
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest
		const req = send(url, { method: 'POST', headers, lookup: guardedLookup as never }, (res) => {
			let body = ''
			res.setEncoding('utf8')
			res.on('data', (chunk: string) => {
				if (body.length < MAX_BODY_BYTES) body = (body + chunk).slice(0, MAX_BODY_BYTES)
			})
			res.on('end', () => finish({ status: res.statusCode ?? null, body, timedOut: false }))
			res.on('error', (error) => finish({ status: null, body, timedOut, error: error.message }))
		})
		const timer = setTimeout(() => {
			timedOut = true
			req.destroy()
			finish({ status: null, body: '', timedOut: true })
		}, input.timeoutMs)
		req.on('error', (error) => finish({ status: null, body: '', timedOut, error: error.message }))
		if (input.signal?.aborted) onAbort()
		else input.signal?.addEventListener('abort', onAbort, { once: true })
		req.end(input.body)
	})
}
