import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import {
	type WebFetchProvider,
	WebFetchRefusedError,
	type WebFetchRequest,
	type WebFetchResult,
} from './types.js'

/**
 * Fetching a URL a model chose, without handing it the inside of the host.
 *
 * A model naming a URL is untrusted input reaching the network stack, and
 * the network the agent runs on is not the network the model is thinking
 * about. `http://169.254.169.254/` is a cloud metadata endpoint holding
 * credentials; `http://localhost:6379/` is whatever the host runs on 6379;
 * `file:///etc/passwd` is not even the network. None of those look unusual
 * in a URL a model produced while reasoning about a public site.
 *
 * So this refuses rather than filtering afterwards. A response body already
 * fetched is already a request that happened, and for a metadata endpoint
 * the request IS the exfiltration — the body only decides whether the model
 * gets to read what was taken.
 */

/** Every scheme this will follow. Everything else is refused by name. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Headers this never forwards, whatever the caller asked for.
 *
 * A tool argument is model-authored, so `headers` is a channel from the
 * model into an outbound request. `authorization` and `cookie` are the two
 * that turn "fetch this page" into "fetch this page as me", and `host` is
 * how a request to an allowed address gets routed to a different virtual
 * host than the one that was checked.
 */
const STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'host', 'proxy-authorization'])

export interface GuardedFetchConfig {
	/** Injected so a test needs no socket. Defaults to the global `fetch`. */
	readonly fetch?: typeof globalThis.fetch
	readonly maxRedirects?: number
	readonly maxBytes?: number
	readonly timeoutMs?: number
	/**
	 * Hostnames this must refuse regardless of where they resolve.
	 *
	 * A host's own belt on top of the address check: an internal name that
	 * resolves publicly is not caught by an IP-range rule, and only the host
	 * knows its own names.
	 */
	readonly blockedHosts?: readonly string[]
	/**
	 * Allow addresses the private-range check would refuse.
	 *
	 * `false`, and the default is the whole point. A test fixture on
	 * `127.0.0.1` is the one legitimate case, and it is a decision a host
	 * makes explicitly rather than one it inherits.
	 */
	readonly allowPrivateAddresses?: boolean
	/**
	 * How a hostname becomes addresses. Defaults to `node:dns`.
	 *
	 * Injected for the reason `fetch` is: a test that has to reach a real
	 * resolver is a test that depends on somebody's DNS. It is also the seam
	 * a host uses to pin resolution — see `assertAllowed` for the rebinding
	 * gap this cannot close on its own.
	 */
	readonly resolve?: (hostname: string) => Promise<readonly string[]>
}

/**
 * Is this address inside the host's own network?
 *
 * Written out rather than pulled from a dependency, because the list is
 * short, stable, and the thing being protected is worth reading in full.
 * IPv6 included: `::1` is loopback and `fc00::/7` is unique-local, and a
 * guard that checked only IPv4 would be bypassed by a name with a AAAA
 * record.
 */
export function isPrivateAddress(address: string): boolean {
	const kind = isIP(address)
	if (kind === 4) {
		const parts = address.split('.').map(Number)
		const [a = 0, b = 0] = parts
		if (a === 127) return true // loopback
		if (a === 10) return true // private
		if (a === 172 && b >= 16 && b <= 31) return true // private
		if (a === 192 && b === 168) return true // private
		if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
		if (a === 0) return true // "this network"
		if (a >= 224) return true // multicast and reserved
		return false
	}
	if (kind === 6) {
		const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
		if (lower === '::1' || lower === '::') return true
		if (lower.startsWith('fe80')) return true // link-local
		if (/^f[cd]/.test(lower)) return true // unique-local fc00::/7
		// An IPv4-mapped address (::ffff:127.0.0.1) is an IPv4 address
		// wearing an IPv6 spelling, and refusing it needs the IPv4 rules.
		const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		if (mapped?.[1]) return isPrivateAddress(mapped[1])
		return false
	}
	return false
}

export class GuardedFetchProvider implements WebFetchProvider {
	constructor(private readonly config: GuardedFetchConfig = {}) {}

	private get maxRedirects(): number {
		return this.config.maxRedirects ?? DEFAULT_MAX_REDIRECTS
	}

	/**
	 * Refuse a URL before anything is sent.
	 *
	 * Called for the original URL AND for every redirect target. That
	 * repetition is the point: checking once and then following redirects is
	 * the classic version of this bug — a permitted public URL answers
	 * `302 -> http://169.254.169.254/`, and a fetch that validated only what
	 * the caller typed follows it happily.
	 */
	private async assertAllowed(rawUrl: string): Promise<URL> {
		let url: URL
		try {
			url = new URL(rawUrl)
		} catch {
			throw new WebFetchRefusedError(`"${rawUrl}" is not a URL.`, {
				url: rawUrl,
				reason: 'scheme',
			})
		}

		if (!ALLOWED_SCHEMES.has(url.protocol)) {
			// Named rather than generic: `file:` and `data:` are the ones a
			// model reaches for by accident, and telling it which scheme was
			// refused is what lets it correct itself.
			throw new WebFetchRefusedError(
				`Refused "${url.protocol}" — only http and https are fetched.`,
				{ url: rawUrl, reason: 'scheme' },
			)
		}

		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
		if (this.config.blockedHosts?.some((blocked) => blocked.toLowerCase() === hostname)) {
			throw new WebFetchRefusedError(`Refused "${hostname}" — the host blocks this name.`, {
				url: rawUrl,
				reason: 'blocked-host',
			})
		}

		if (this.config.allowPrivateAddresses === true) return url

		// RESOLVED, not just parsed. A hostname check alone is bypassed by any
		// name whose A record points inside — which is a thing anyone can set
		// up on a domain they own, and costs nothing to try.
		//
		// The residual gap is stated rather than hidden: between this lookup
		// and the connection, the name can be re-resolved to something else
		// (DNS rebinding). Closing that needs the fetch to pin the address it
		// checked, which the platform `fetch` gives no way to do. A host that
		// needs that guarantee supplies its own `fetch` that does.
		const resolve =
			this.config.resolve ??
			(async (name: string) => (await lookup(name, { all: true })).map((r) => r.address))
		let addresses: readonly string[]
		if (isIP(hostname)) {
			addresses = [hostname]
		} else {
			try {
				addresses = await resolve(hostname)
			} catch (err) {
				// REFUSE. `.catch(() => [])` was the first version of this line
				// and it is fail-open: an empty list satisfies the loop below,
				// so a name nobody could resolve was treated as a name with no
				// private addresses — and the fetch that followed would resolve
				// it again for real, against whatever answered the second time.
				throw new WebFetchRefusedError(
					`Refused "${hostname}" — it could not be resolved (${err instanceof Error ? err.message : String(err)}), so nothing here can say where it points.`,
					{ url: rawUrl, reason: 'private-address' },
				)
			}
			if (addresses.length === 0) {
				throw new WebFetchRefusedError(`Refused "${hostname}" — it resolves to no addresses.`, {
					url: rawUrl,
					reason: 'private-address',
				})
			}
		}

		for (const address of addresses) {
			if (isPrivateAddress(address)) {
				throw new WebFetchRefusedError(
					`Refused "${hostname}" — it resolves to ${address}, inside this host's own network.`,
					{ url: rawUrl, reason: 'private-address' },
				)
			}
		}
		return url
	}

	async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
		const doFetch = this.config.fetch ?? globalThis.fetch
		const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const maxBytes = this.config.maxBytes ?? DEFAULT_MAX_BYTES

		const headers: Record<string, string> = {}
		for (const [key, value] of Object.entries(request.headers ?? {})) {
			if (!STRIPPED_HEADERS.has(key.toLowerCase())) headers[key] = value
		}

		const timer = new AbortController()
		const deadline = setTimeout(() => timer.abort(), timeoutMs)
		// Both: the caller's cancel and our own deadline. Honouring only one
		// leaves the other unable to stop a fetch that has stopped being
		// wanted.
		request.signal?.addEventListener('abort', () => timer.abort(), { once: true })

		try {
			const redirects: string[] = []
			let current = await this.assertAllowed(request.url)

			for (let hop = 0; ; hop++) {
				if (hop > this.maxRedirects) {
					throw new WebFetchRefusedError(
						`Refused after ${this.maxRedirects} redirects from "${request.url}".`,
						{ url: request.url, reason: 'redirect-limit' },
					)
				}
				redirects.push(current.toString())

				// `manual`, so every hop comes back here to be checked. Letting
				// the platform follow redirects is exactly the hole this class
				// exists to close: it would land on the final URL having never
				// asked whether that URL was allowed.
				const response = await doFetch(current, {
					headers,
					redirect: 'manual',
					signal: timer.signal,
				})

				const location = response.headers.get('location')
				if (response.status >= 300 && response.status < 400 && location) {
					// Resolved against the current URL, because a `Location` may
					// be relative — and a relative one that is not resolved would
					// be checked as a different URL than the one followed.
					const next = new URL(location, current)
					try {
						current = await this.assertAllowed(next.toString())
					} catch (err) {
						if (err instanceof WebFetchRefusedError) {
							throw new WebFetchRefusedError(
								`A redirect from "${current.toString()}" pointed at "${next.toString()}", which was refused: ${err.message}`,
								{ url: next.toString(), reason: 'redirect-target' },
							)
						}
						throw err
					}
					continue
				}

				const text = await response.text()
				const truncated = Buffer.byteLength(text) > maxBytes
				const body = truncated ? Buffer.from(text).subarray(0, maxBytes).toString('utf8') : text
				const contentType = response.headers.get('content-type') ?? undefined

				return {
					url: current.toString(),
					status: response.status,
					...(contentType === undefined ? {} : { contentType }),
					body,
					truncated,
					redirects,
				}
			}
		} finally {
			clearTimeout(deadline)
		}
	}
}
