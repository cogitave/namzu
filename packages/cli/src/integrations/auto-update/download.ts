/**
 * Fetch the release tarball ourselves and check it against the digest the
 * registry published, so that what gets installed is exactly the bytes that
 * were checked: the package manager is then handed a file, not a name it would
 * resolve through whatever registry settings the machine has.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type DownloadFailure = 'unverifiable' | 'integrity' | 'network' | 'disk_full'

export class DownloadError extends Error {
	constructor(
		readonly code: DownloadFailure,
		message: string,
	) {
		super(message)
		this.name = 'DownloadError'
	}
}

export interface DownloadOptions {
	/** The tarball address the registry gave. */
	readonly url: string
	/** The registry's `sha512-…` digest for it. */
	readonly integrity: string
	/** The registry the release was learned from; the tarball must live on its origin. */
	readonly registry: string
	/** Where the verified file ends up. */
	readonly destination: string
	readonly fetch?: typeof fetch
	/** Give up on the download after this long. Default five minutes. */
	readonly timeoutMs?: number
	/** Refuse a download bigger than this. Default 200 MiB. */
	readonly maxBytes?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

/** `sha512-<base64>` as raw bytes, or null when it is not that. */
export function parseSha512(integrity: string): Buffer | null {
	const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(integrity)
	if (!match?.[1]) return null
	const bytes = Buffer.from(match[1], 'base64')
	return bytes.length === 64 ? bytes : null
}

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}

/**
 * Download `url` to `destination` and leave it there only if its sha512 is the
 * registry's digest. Throws a {@link DownloadError}; on any failure nothing is
 * left at `destination`.
 */
export async function downloadVerifiedTarball(options: DownloadOptions): Promise<void> {
	const expected = parseSha512(options.integrity)
	if (!expected) throw new DownloadError('unverifiable', 'the registry gave no usable checksum')
	if (!sameOrigin(options.url, options.registry)) {
		throw new DownloadError('unverifiable', 'the download address is not on the registry')
	}
	const part = `${options.destination}.part`
	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(new Error('download timed out')),
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	)
	try {
		mkdirSync(dirname(options.destination), { recursive: true })
		let response: Response
		try {
			response = await (options.fetch ?? fetch)(options.url, { signal: controller.signal })
		} catch (error) {
			throw new DownloadError('network', error instanceof Error ? error.message : String(error))
		}
		if (!response.ok || !response.body) {
			throw new DownloadError('network', `the registry answered ${response.status}`)
		}
		const hash = createHash('sha512')
		const limit = options.maxBytes ?? DEFAULT_MAX_BYTES
		let seen = 0
		const measure = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				seen += chunk.length
				if (seen > limit) {
					done(new DownloadError('network', 'the download is larger than expected'))
					return
				}
				hash.update(chunk)
				done(null, chunk)
			},
		})
		try {
			await pipeline(
				Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
				measure,
				createWriteStream(part),
				{ signal: controller.signal },
			)
		} catch (error) {
			if (error instanceof DownloadError) throw error
			const code = (error as NodeJS.ErrnoException).code
			throw new DownloadError(
				code === 'ENOSPC' ? 'disk_full' : 'network',
				error instanceof Error ? error.message : String(error),
			)
		}
		const actual = hash.digest()
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			throw new DownloadError('integrity', 'the download does not match the registry checksum')
		}
		renameSync(part, options.destination)
	} finally {
		clearTimeout(timer)
		rmSync(part, { force: true })
	}
}
