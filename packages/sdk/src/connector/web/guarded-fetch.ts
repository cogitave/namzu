import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import {
	ConnectorHttpOperation,
	DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES,
	DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS,
	validateConnectorMaxResponseBytes,
	validateConnectorTimeoutMs,
} from '../http-operation.js'
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
	readonly resolve?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>
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
		// `net.isIP` accepts scoped link-local values such as `fe80::1%lo0`,
		// while the URL parser intentionally does not. The zone names an
		// interface, not an address bit, so remove it before canonicalising.
		const zoneAt = lower.indexOf('%')
		const unscoped = zoneAt === -1 ? lower : lower.slice(0, zoneAt)
		// Canonicalise before testing mapped addresses. `new URL()` turns the
		// dotted spelling `::ffff:127.0.0.1` into `::ffff:7f00:1`; checking only
		// a dotted suffix would therefore accept the exact value this provider
		// receives from a model-authored URL.
		const canonical = new URL(`http://[${unscoped}]/`).hostname.slice(1, -1)
		if (canonical === '::1' || canonical === '::') return true
		const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
		if (mapped?.[1] && mapped[2]) {
			const high = Number.parseInt(mapped[1], 16)
			const low = Number.parseInt(mapped[2], 16)
			return isPrivateAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
		}
		const firstHextet = Number.parseInt(canonical.split(':', 1)[0] ?? '0', 16)
		if ((firstHextet & 0xffc0) === 0xfe80) return true // link-local fe80::/10
		if ((firstHextet & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
		if ((firstHextet & 0xff00) === 0xff00) return true // multicast ff00::/8
		return false
	}
	return false
}

export class GuardedFetchProvider implements WebFetchProvider {
	private readonly timeoutMs: number
	private readonly maxBytes: number
	private readonly maxRedirects: number

	constructor(private readonly config: GuardedFetchConfig = {}) {
		this.timeoutMs = validateConnectorTimeoutMs(
			config.timeoutMs ?? DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS,
			'GuardedFetchProvider timeoutMs',
		)
		this.maxBytes = validateConnectorMaxResponseBytes(
			config.maxBytes ?? DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES,
			'GuardedFetchProvider maxBytes',
		)
		const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS
		if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
			throw new Error(
				`GuardedFetchProvider maxRedirects must be a non-negative safe integer; received ${String(maxRedirects)}`,
			)
		}
		this.maxRedirects = maxRedirects
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
	private async assertAllowed(rawUrl: string, operation: ConnectorHttpOperation): Promise<URL> {
		operation.throwIfStopped()
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

		if (this.config.allowPrivateAddresses === true) {
			operation.throwIfStopped()
			return url
		}

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
				addresses = await operation.run(() => resolve(hostname, operation.signal))
			} catch (err) {
				// A caller cancellation or this operation's deadline is not a DNS
				// policy refusal. Preserve the exact first cause rather than wrapping
				// it as though the hostname itself were unsafe.
				operation.throwIfStopped()
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
		operation.throwIfStopped()
		return url
	}

	async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
		const doFetch = this.config.fetch ?? globalThis.fetch
		const operation = new ConnectorHttpOperation(
			request.signal,
			this.timeoutMs,
			`Web fetch "${request.url}"`,
		)

		try {
			const headers: Record<string, string> = {}
			for (const [key, value] of Object.entries(request.headers ?? {})) {
				if (!STRIPPED_HEADERS.has(key.toLowerCase())) headers[key] = value
			}

			const redirects: string[] = []
			let redirectsFollowed = 0
			let current = await this.assertAllowed(request.url, operation)

			for (;;) {
				operation.throwIfStopped()
				redirects.push(current.toString())

				// `manual`, so every hop comes back here to be checked. Letting
				// the platform follow redirects is exactly the hole this class
				// exists to close: it would land on the final URL having never
				// asked whether that URL was allowed.
				const response = await operation.run(() =>
					doFetch(current, {
						headers,
						redirect: 'manual',
						signal: operation.signal,
					}),
				)

				const location = response.headers.get('location')
				if (response.status >= 300 && response.status < 400 && location) {
					// The budget is about redirects FOLLOWED. Refuse before parsing or
					// resolving the forbidden next target, so a spent budget cannot be
					// turned into one last DNS query.
					if (redirectsFollowed >= this.maxRedirects) {
						cancelResponseBody(response, new Error('redirect limit reached'))
						operation.throwIfStopped()
						throw new WebFetchRefusedError(
							`Refused after ${this.maxRedirects} redirects from "${request.url}".`,
							{ url: request.url, reason: 'redirect-limit' },
						)
					}
					// Resolved against the current URL, because a `Location` may
					// be relative — and a relative one that is not resolved would
					// be checked as a different URL than the one followed.
					const next = new URL(location, current)
					cancelResponseBody(response, new Error('following redirect'))
					operation.throwIfStopped()
					try {
						current = await this.assertAllowed(next.toString(), operation)
					} catch (err) {
						operation.throwIfStopped()
						if (err instanceof WebFetchRefusedError) {
							throw new WebFetchRefusedError(
								`A redirect from "${current.toString()}" pointed at "${next.toString()}", which was refused: ${err.message}`,
								{ url: next.toString(), reason: 'redirect-target' },
							)
						}
						throw err
					}
					redirectsFollowed++
					continue
				}

				const { body, truncated } = await readCappedResponseText(response, operation, this.maxBytes)
				const contentType = response.headers.get('content-type') ?? undefined
				operation.throwIfStopped()

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
			operation.close()
		}
	}
}

async function readCappedResponseText(
	response: Response,
	operation: ConnectorHttpOperation,
	maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
	// Native fetch exposes a byte stream whenever bytes exist. This fallback
	// keeps Response-shaped host doubles compatible while still racing their
	// text promise and applying the same byte semantics after it settles.
	if (!response.body) {
		const text = await operation.run(() => response.text())
		const bytes = new TextEncoder().encode(text)
		if (bytes.byteLength <= maxBytes) {
			operation.throwIfStopped()
			return { body: text, truncated: false }
		}
		operation.throwIfStopped()
		return {
			body: decodeUtf8Prefix(bytes.slice(0, maxBytes), true),
			truncated: true,
		}
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	let truncated = false
	try {
		for (;;) {
			const { done, value } = await operation.run(() => reader.read())
			if (done) break
			if (value.byteLength === 0) continue

			const remaining = maxBytes - totalBytes
			if (value.byteLength > remaining) {
				// Copy the retained prefix. `subarray` would keep an arbitrarily
				// large hostile chunk's backing buffer alive through the result.
				if (remaining > 0) chunks.push(value.slice(0, remaining))
				totalBytes += remaining
				truncated = true
				cancelReader(reader, new Error(`web response exceeded ${maxBytes} bytes`))
				operation.throwIfStopped()
				break
			}

			chunks.push(value)
			totalBytes += value.byteLength
		}
	} catch (error) {
		cancelReader(reader, error)
		throw error
	} finally {
		reader.releaseLock()
	}

	operation.throwIfStopped()
	const bytes = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { body: decodeUtf8Prefix(bytes, truncated), truncated }
}

function decodeUtf8Prefix(bytes: Uint8Array, truncated: boolean): string {
	const decoder = new TextDecoder()
	// Streaming decode deliberately omits the final flush for a truncated
	// prefix. That drops an incomplete trailing code point instead of showing
	// the model a synthetic replacement character that was never in the page.
	return decoder.decode(bytes, { stream: truncated })
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
	try {
		void Promise.resolve(reader.cancel(reason)).catch(() => undefined)
	} catch {
		// Cleanup must not replace the operation's real outcome.
	}
}

function cancelResponseBody(response: Response, reason: unknown): void {
	try {
		void Promise.resolve(response.body?.cancel(reason)).catch(() => undefined)
	} catch {
		// Cleanup must not turn a redirect refusal into a transport failure.
	}
}
