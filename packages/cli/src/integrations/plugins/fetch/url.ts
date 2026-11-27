/**
 * An https download with a size cap, a time limit and redirects that may not
 * leave https: the one place a catalog file or a plugin archive is fetched.
 *
 * Nothing is sent but a plain request: no cookies, no sign-in. At most five
 * redirects are followed, and none to an address that is not https. The body
 * is read as it arrives and the download is dropped the moment it passes the
 * cap. The only way plain http is ever used is a test's own option, and only
 * for 127.0.0.1.
 */

import { EXIT_DATAERR, EXIT_NOINPUT, EXIT_UNAVAILABLE, EXIT_USAGE } from '../../../exit-codes.js'
import { FetchError, type FetchOptions, cancelledFetch } from './git.js'

export const CATALOG_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024
export const CATALOG_DOWNLOAD_TIMEOUT_MS = 30_000
export const ARCHIVE_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024
export const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000
export const MAX_REDIRECTS = 5

export interface DownloadRequest {
	readonly url: string
	readonly maxBytes: number
	readonly timeoutMs: number
	/** Whether a content type is acceptable. */
	readonly acceptType: (contentType: string) => boolean
	/** What the download is, for messages: "catalog", "archive". */
	readonly subject: string
}

function allowedUrl(url: URL, options: FetchOptions): boolean {
	if (url.protocol === 'https:') return true
	return (
		options.allowLoopbackHttp === true && url.protocol === 'http:' && url.hostname === '127.0.0.1'
	)
}

/** The accepted types of a catalog: JSON, or plain text (some hosts serve raw files that way). */
export function isCatalogType(contentType: string): boolean {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return (
		type === '' ||
		type === 'application/json' ||
		type.endsWith('+json') ||
		type.startsWith('text/plain')
	)
}

/** Anything but a web page. A zip is checked by its own reader. */
export function isArchiveType(contentType: string): boolean {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return type !== 'text/html' && type !== 'application/json'
}

/** Download `request.url` into memory, or throw a {@link FetchError} saying why not. */
export async function download(
	request: DownloadRequest,
	options: FetchOptions = {},
): Promise<Buffer> {
	let current: URL
	try {
		current = new URL(options.rewriteUrl?.(request.url) ?? request.url)
	} catch {
		throw new FetchError(EXIT_USAGE, `${request.url.slice(0, 80)} is not an address.`, 'address')
	}
	if (!allowedUrl(current, options))
		throw new FetchError(EXIT_USAGE, 'Only https:// addresses are downloaded.', 'address')
	if (current.username !== '' || current.password !== '')
		throw new FetchError(
			EXIT_USAGE,
			'Remove the sign-in details from the address; Namzu does not send them.',
			'address',
		)
	const fetcher = options.fetchImpl ?? fetch
	if (options.signal?.aborted) throw cancelledFetch()
	const controller = new AbortController()
	const onAbort = (): void => controller.abort()
	options.signal?.addEventListener('abort', onAbort, { once: true })
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, request.timeoutMs)
	const host = current.hostname
	try {
		for (let hop = 0; ; hop++) {
			let response: Response
			try {
				response = await fetcher(current.toString(), {
					redirect: 'manual',
					signal: controller.signal,
					headers: {
						accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
						'user-agent': 'namzu-plugins',
					},
				})
			} catch {
				if (options.signal?.aborted) throw cancelledFetch()
				if (timedOut)
					throw new FetchError(
						EXIT_UNAVAILABLE,
						`${host} did not finish answering within ${Math.round(request.timeoutMs / 1000)} seconds.`,
						'timeout',
					)
				throw new FetchError(EXIT_UNAVAILABLE, `Could not reach ${host}.`, 'network')
			}
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location')
				await response.body?.cancel().catch(() => undefined)
				if (location === null)
					throw new FetchError(
						EXIT_UNAVAILABLE,
						`${host} redirected without saying where.`,
						'redirect',
					)
				if (hop >= MAX_REDIRECTS)
					throw new FetchError(
						EXIT_UNAVAILABLE,
						`${host} redirected more than ${MAX_REDIRECTS} times.`,
						'redirect',
					)
				let next: URL
				try {
					next = new URL(location, current)
				} catch {
					throw new FetchError(
						EXIT_UNAVAILABLE,
						`${host} redirected to something that is not an address.`,
						'redirect',
					)
				}
				if (!allowedUrl(next, options))
					throw new FetchError(
						EXIT_DATAERR,
						`${host} redirected to an address that is not https, so the download was stopped.`,
						'redirect',
					)
				current = next
				continue
			}
			if (response.status === 404 || response.status === 410)
				throw new FetchError(
					EXIT_NOINPUT,
					`Nothing is at that address on ${current.hostname} (${response.status}).`,
					'not-found',
				)
			if (response.status === 401 || response.status === 403)
				throw new FetchError(
					EXIT_NOINPUT,
					`${current.hostname} wants a sign-in for that address, which Namzu does not send.`,
					'auth',
				)
			if (!response.ok)
				throw new FetchError(
					EXIT_UNAVAILABLE,
					`${current.hostname} answered ${response.status}.`,
					'status',
				)
			if (!request.acceptType(response.headers.get('content-type') ?? ''))
				throw new FetchError(
					EXIT_DATAERR,
					`${current.hostname} sent something that is not a ${request.subject} (${(response.headers.get('content-type') ?? '').split(';')[0]}).`,
					'type',
				)
			const declared = Number(response.headers.get('content-length') ?? '')
			const tooBig = new FetchError(
				EXIT_DATAERR,
				`The ${request.subject} is larger than ${Math.round(request.maxBytes / (1024 * 1024))} MiB, so it was not downloaded.`,
				'size',
			)
			if (Number.isFinite(declared) && declared > request.maxBytes) {
				await response.body?.cancel().catch(() => undefined)
				throw tooBig
			}
			if (response.body === null) return Buffer.alloc(0)
			const reader = response.body.getReader()
			const chunks: Buffer[] = []
			let total = 0
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					total += value.byteLength
					if (total > request.maxBytes) {
						await reader.cancel().catch(() => undefined)
						throw tooBig
					}
					chunks.push(Buffer.from(value))
				}
			} catch (error) {
				if (error instanceof FetchError) throw error
				if (options.signal?.aborted) throw cancelledFetch()
				if (timedOut)
					throw new FetchError(
						EXIT_UNAVAILABLE,
						`${host} did not finish sending within ${Math.round(request.timeoutMs / 1000)} seconds.`,
						'timeout',
					)
				throw new FetchError(EXIT_UNAVAILABLE, `The download from ${host} was cut off.`, 'network')
			}
			return Buffer.concat(chunks)
		}
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener('abort', onAbort)
	}
}

/** A catalog file over https as text. */
export async function fetchCatalogText(url: string, options: FetchOptions = {}): Promise<string> {
	const bytes = await download(
		{
			url,
			maxBytes: CATALOG_DOWNLOAD_MAX_BYTES,
			timeoutMs: CATALOG_DOWNLOAD_TIMEOUT_MS,
			acceptType: isCatalogType,
			subject: 'catalog',
		},
		options,
	)
	return bytes.toString('utf8')
}
