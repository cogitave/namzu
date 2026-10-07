import { BlockList, isIP } from 'node:net'
import {
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	LINK_PREVIEW_PAGE_MAX_BYTES,
	type LinkPreviewImageKind,
	type LinkPreviewPage,
} from '../shared/link-preview-protocol.js'

/**
 * Link previews fetch a page a model wrote about, so the address is
 * attacker-chosen. Everything here fails closed to `null` and never carries a
 * reason: no URL, page text or error text may reach logs or diagnostics.
 */

export interface LinkPreviewResponse {
	status: number
	/** Lower-case header lookup. */
	header(name: string): string | undefined
	/** Set when the request stopped at a redirect instead of following it. */
	location?: string
	body: AsyncIterable<Uint8Array>
	cancel(): void
}

export interface LinkPreviewNetwork {
	resolve(hostname: string): Promise<readonly string[]>
	request(url: string, accept: string, signal: AbortSignal): Promise<LinkPreviewResponse>
}

const OPERATION_DEADLINE_MS = 8_000
const MAX_REDIRECTS = 4
const MAX_URL_LENGTH = 2_048
const SUCCESS_TTL_MS = 15 * 60_000
const FAILURE_TTL_MS = 2 * 60_000
const MAX_ENTRIES = 128
const MAX_IMAGE_CACHE_CHARS = 24 * 1024 * 1024
const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
const IMAGE_ACCEPT =
	'image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9,*/*;q=0.1'

const refused = new BlockList()
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.31.196.0', 24],
	['192.52.193.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['192.175.48.0', 24],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	// Includes the limited broadcast address.
	['240.0.0.0', 4],
] as const)
	refused.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['3fff::', 20],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
] as const)
	refused.addSubnet(network, prefix, 'ipv6')

/** True only for a syntactically valid global unicast address. */
export function isPublicAddress(address: string): boolean {
	if (typeof address !== 'string') return false
	let value = address.trim()
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
	const zone = value.indexOf('%')
	if (zone >= 0) value = value.slice(0, zone)
	const family = isIP(value)
	if (family === 0) return false
	// BlockList matches an IPv4-mapped IPv6 address against its IPv4 rules.
	return !refused.check(value, family === 4 ? 'ipv4' : 'ipv6')
}

const REFUSED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet']

/** The only shape of address a preview will request, or `undefined`. */
export function previewTarget(value: unknown): URL | undefined {
	if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code <= 32 || code === 127) return undefined
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return undefined
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return undefined
	const host = url.hostname.toLowerCase().replace(/\.$/, '')
	if (!host) return undefined
	if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return isPublicAddress(host) ? url : undefined
	if (!host.includes('.') || host === 'localhost') return undefined
	if (REFUSED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined
	return url
}

function isIpLiteral(hostname: string): boolean {
	return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
}

/**
 * Residual gap: resolution here and the connection made by the request are
 * two lookups. Both go through the session's host cache, which in practice
 * answers the same way, but that is not a hard pin against DNS rebinding.
 */
async function hostAllowed(network: LinkPreviewNetwork, url: URL): Promise<boolean> {
	if (isIpLiteral(url.hostname)) return true
	const addresses = await network.resolve(url.hostname.replace(/\.$/, ''))
	return addresses.length > 0 && addresses.every(isPublicAddress)
}

class DeadlineError extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DeadlineError())
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DeadlineError())
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}

/** Follows validated redirects; every hop is checked like the first. */
async function open(
	network: LinkPreviewNetwork,
	start: URL,
	accept: string,
	signal: AbortSignal,
): Promise<{ response: LinkPreviewResponse; url: URL } | undefined> {
	let url = start
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!(await abortable(hostAllowed(network, url), signal))) return undefined
		const response = await abortable(network.request(url.href, accept, signal), signal)
		if (response.status >= 300 && response.status < 400) {
			response.cancel()
			if (!response.location || hop === MAX_REDIRECTS) return undefined
			const next = previewTarget(new URL(response.location, url).href)
			if (!next) return undefined
			url = next
			continue
		}
		if (response.status < 200 || response.status >= 300) {
			response.cancel()
			return undefined
		}
		return { response, url }
	}
	return undefined
}

function mediaType(contentType: string | undefined): string | undefined {
	return contentType?.split(';')[0]?.trim().toLowerCase() || undefined
}

function declaredCharset(contentType: string | undefined): string | undefined {
	const match = contentType?.match(/;\s*charset\s*=\s*"?([^";\s]+)"?/i)
	return match?.[1]
}

function sniffedCharset(bytes: Uint8Array): string | undefined {
	const text = Buffer.from(bytes.subarray(0, 2_048)).toString('latin1')
	const direct = text.match(/<meta\s+charset\s*=\s*["']?\s*([\w:.-]+)/i)
	if (direct) return direct[1]
	const equiv = text.match(
		/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w:.-]+)/i,
	)
	return equiv?.[1]
}

function decode(bytes: Uint8Array, label: string | undefined): string {
	if (label) {
		try {
			return new TextDecoder(label).decode(bytes)
		} catch {
			/* Unknown label: fall through to UTF-8. */
		}
	}
	return new TextDecoder('utf-8').decode(bytes)
}

const HEAD_CLOSE = [0x3c, 0x2f, 0x68, 0x65, 0x61, 0x64] // "</head"

function lowerAscii(byte: number): number {
	return byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte
}

/**
 * Incremental scan for `</head` + `>`. `from` is where the previous scan
 * stopped, so each byte is examined once. Returns the cut length when found.
 */
function scanHead(
	state: { from: number; close: number },
	buffer: Uint8Array,
	length: number,
): number | undefined {
	if (state.close < 0) {
		let i = state.from
		for (; i + HEAD_CLOSE.length < length; i++) {
			let match = true
			for (let k = 0; k < HEAD_CLOSE.length; k++)
				if (lowerAscii(buffer[i + k] as number) !== HEAD_CLOSE[k]) {
					match = false
					break
				}
			if (!match) continue
			// `</header>` is not the head's end.
			const next = lowerAscii(buffer[i + HEAD_CLOSE.length] as number)
			const letter =
				(next >= 0x61 && next <= 0x7a) || (next >= 0x30 && next <= 0x39) || next === 0x2d
			if (letter) continue
			state.close = i + HEAD_CLOSE.length
			break
		}
		if (state.close < 0) {
			state.from = i
			return undefined
		}
	}
	for (let j = Math.max(state.from, state.close); j < length; j++)
		if (buffer[j] === 0x3e) return j + 1
	state.from = Math.max(state.from, length)
	return undefined
}

async function readPage(
	response: LinkPreviewResponse,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	const buffer = new Uint8Array(LINK_PREVIEW_PAGE_MAX_BYTES)
	let length = 0
	const state = { from: 0, close: -1 }
	for await (const chunk of response.body) {
		if (signal.aborted) throw new DeadlineError()
		const take = Math.min(chunk.length, buffer.length - length)
		buffer.set(chunk.subarray(0, take), length)
		length += take
		const cut = scanHead(state, buffer, length)
		if (cut !== undefined) {
			response.cancel()
			return buffer.slice(0, cut)
		}
		if (length >= buffer.length) {
			response.cancel()
			return buffer.slice(0, length)
		}
	}
	return buffer.slice(0, length)
}

function startsWith(bytes: Uint8Array, offset: number, text: number[]): boolean {
	return text.every((value, index) => bytes[offset + index] === value)
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

function sniffImage(bytes: Uint8Array, kind: LinkPreviewImageKind): string | undefined {
	if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a')))
		return 'image/gif'
	if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP')))
		return 'image/webp'
	if (startsWith(bytes, 4, ascii('ftypavif')) || startsWith(bytes, 4, ascii('ftypavis')))
		return 'image/avif'
	if (kind === 'icon' && startsWith(bytes, 0, [0, 0, 1, 0])) return 'image/x-icon'
	return undefined
}

async function readImage(
	response: LinkPreviewResponse,
	cap: number,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	const declared = response.header('content-length')
	if (declared !== undefined && /^\d+$/.test(declared.trim()) && Number(declared) > cap) {
		response.cancel()
		return undefined
	}
	const chunks: Uint8Array[] = []
	let total = 0
	for await (const chunk of response.body) {
		if (signal.aborted) throw new DeadlineError()
		total += chunk.length
		if (total > cap) {
			response.cancel()
			return undefined
		}
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

interface Entry<T> {
	value: T
	expires: number
	size: number
}

/** Map insertion order is the recency order: a hit re-inserts. */
class Lru<T> {
	private readonly entries = new Map<string, Entry<T>>()
	private sizeTotal = 0
	constructor(
		private readonly maxEntries: number,
		private readonly maxSize: number,
	) {}
	get(key: string, now: number): { value: T } | undefined {
		const entry = this.entries.get(key)
		if (!entry) return undefined
		this.entries.delete(key)
		this.sizeTotal -= entry.size
		if (entry.expires <= now) return undefined
		this.entries.set(key, entry)
		this.sizeTotal += entry.size
		return { value: entry.value }
	}
	set(key: string, value: T, expires: number, size: number): void {
		const old = this.entries.get(key)
		if (old) this.sizeTotal -= old.size
		this.entries.delete(key)
		if (size > this.maxSize) return
		this.entries.set(key, { value, expires, size })
		this.sizeTotal += size
		while (this.entries.size > this.maxEntries || this.sizeTotal > this.maxSize) {
			const oldest = this.entries.keys().next().value
			if (oldest === undefined) break
			this.sizeTotal -= this.entries.get(oldest)?.size ?? 0
			this.entries.delete(oldest)
		}
	}
}

export interface LinkPreviewService {
	page(url: unknown): Promise<LinkPreviewPage | null>
	image(url: unknown, kind: unknown): Promise<string | null>
}

export function createLinkPreviewService(options: {
	network: LinkPreviewNetwork
	now?: () => number
	maxConcurrent?: number
}): LinkPreviewService {
	const { network } = options
	const now = options.now ?? Date.now
	const maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
	const pages = new Lru<LinkPreviewPage | null>(MAX_ENTRIES, Number.POSITIVE_INFINITY)
	const images = new Lru<string | null>(MAX_ENTRIES, MAX_IMAGE_CACHE_CHARS)
	const inflight = new Map<string, Promise<unknown>>()

	let running = 0
	const waiting: Array<() => void> = []
	// The deadline starts when an operation starts, not while it queues.
	async function slot<T>(work: () => Promise<T>): Promise<T> {
		if (running >= maxConcurrent) await new Promise<void>((resolve) => waiting.push(resolve))
		else running++
		try {
			return await work()
		} finally {
			const next = waiting.shift()
			if (next) next()
			else running--
		}
	}

	async function withDeadline<T>(
		work: (signal: AbortSignal) => Promise<T | null>,
	): Promise<T | null> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), OPERATION_DEADLINE_MS)
		try {
			return await work(controller.signal)
		} catch {
			return null
		} finally {
			clearTimeout(timer)
		}
	}

	async function cached<T>(
		cache: Lru<T | null>,
		key: string,
		measure: (value: T) => number,
		load: () => Promise<T | null>,
	): Promise<T | null> {
		const hit = cache.get(key, now())
		if (hit) return hit.value
		const pending = inflight.get(key)
		if (pending) return (await pending) as T | null
		const promise = (async () => {
			const value = await slot(load)
			cache.set(
				key,
				value,
				now() + (value === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
				value === null ? 0 : measure(value),
			)
			return value
		})()
		inflight.set(key, promise)
		try {
			return await promise
		} finally {
			inflight.delete(key)
		}
	}

	return {
		async page(input) {
			try {
				const target = previewTarget(input)
				if (!target) return null
				return await cached(
					pages,
					`page:${target.href}`,
					() => 0,
					() =>
						withDeadline(async (signal) => {
							const opened = await open(network, target, PAGE_ACCEPT, signal)
							if (!opened) return null
							const { response, url } = opened
							const type = response.header('content-type')
							const media = mediaType(type)
							if (media !== 'text/html' && media !== 'application/xhtml+xml') {
								response.cancel()
								return null
							}
							const bytes = await abortable(readPage(response, signal), signal)
							if (!bytes) return null
							const head = decode(bytes, declaredCharset(type) ?? sniffedCharset(bytes))
							return { url: url.href, head }
						}),
				)
			} catch {
				return null
			}
		},
		async image(input, kind) {
			try {
				if (kind !== 'image' && kind !== 'icon') return null
				const target = previewTarget(input)
				if (!target) return null
				return await cached(
					images,
					`image:${kind}:${target.href}`,
					(value) => value.length,
					() =>
						withDeadline(async (signal) => {
							const opened = await open(network, target, IMAGE_ACCEPT, signal)
							if (!opened) return null
							const bytes = await abortable(
								readImage(opened.response, LINK_PREVIEW_IMAGE_MAX_BYTES[kind], signal),
								signal,
							)
							if (!bytes) return null
							const mime = sniffImage(bytes, kind)
							if (!mime) return null
							return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
						}),
				)
			} catch {
				return null
			}
		},
	}
}
