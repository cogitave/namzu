import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadWslPackage, PinnedWslPackage, WslcSetupProgress } from './contract.js'

/**
 * The WSL release setup installs: Microsoft's per-machine MSI for x64 from
 * https://github.com/microsoft/WSL/releases/tag/3.0.1. The size and digest are
 * the ones the release API reports for the asset, and were recomputed from a
 * download of the file.
 */
export const PINNED_WSL_PACKAGE: PinnedWslPackage = {
	version: '3.0.1.0',
	architecture: 'x64',
	url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
	sha256: '28b1a0d013640a2ac95898ea705fa186e5b4ff767a1c1b49257161bc106599c6',
	sizeBytes: 367669248,
}

/** Attempts before a download gives up, counting the first. */
const MAX_ATTEMPTS = 5
/** Backoff before attempt n+1 is `BASE_DELAY_MS * 2 ** n`. */
const BASE_DELAY_MS = 1000
/** Report progress at most once per this many bytes (and at the end). */
const PROGRESS_STEP_BYTES = 512 * 1024

class RetryableError extends Error {}
class FatalError extends Error {}

function fileNameOf(url: string): string {
	const name = new URL(url).pathname.split('/').pop() ?? ''
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
		throw new FatalError('The package address has no usable file name.')
	}
	return name
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size
	} catch {
		return undefined
	}
}

function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256')
		const stream = createReadStream(path, { signal })
		stream.on('data', (chunk) => hash.update(chunk))
		stream.on('error', reject)
		stream.on('end', () => resolve(hash.digest('hex')))
	})
}

/**
 * One attempt: continue `part` from its current size when the server honours
 * the range, or start over when it does not. Resolves when `part` holds
 * `sizeBytes`.
 */
async function attempt(
	pinned: PinnedWslPackage,
	part: string,
	fetchImpl: typeof fetch,
	onProgress: ((progress: WslcSetupProgress) => void) | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	let have = (await sizeOf(part)) ?? 0
	if (have > pinned.sizeBytes) {
		await rm(part, { force: true })
		have = 0
	}
	if (have === pinned.sizeBytes) return
	let response: Response
	try {
		response = await fetchImpl(pinned.url, {
			headers: have > 0 ? { Range: `bytes=${have}-` } : {},
			redirect: 'follow',
			signal,
		})
	} catch (error) {
		if (signal?.aborted) throw signal.reason
		throw new RetryableError(error instanceof Error ? error.message : 'The request failed.')
	}
	if (response.status === 416) {
		// The partial file does not fit what the server has; start over.
		await rm(part, { force: true })
		throw new RetryableError('The server refused the resume range.')
	}
	if (response.status !== 200 && response.status !== 206) {
		const message = `The server answered ${response.status}.`
		if (response.status === 429 || response.status >= 500) throw new RetryableError(message)
		throw new FatalError(message)
	}
	if (!response.body) throw new RetryableError('The server sent no data.')
	let resumed = response.status === 206 && have > 0
	if (resumed) {
		// A 206 for another offset would append misaligned bytes: drop the
		// partial file and fetch again from zero.
		const start = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1]
		if (start === undefined || Number(start) !== have) {
			await response.body.cancel().catch(() => undefined)
			await rm(part, { force: true })
			throw new RetryableError('The server answered for a different part of the file.')
		}
	} else {
		resumed = false
		have = 0
	}
	const handle = await open(part, resumed ? 'a' : 'w')
	let done = have
	let reported = have
	try {
		const reader = response.body.getReader()
		try {
			for (;;) {
				const { value, done: finished } = await reader.read()
				if (finished) break
				await handle.write(value)
				done += value.byteLength
				if (done - reported >= PROGRESS_STEP_BYTES) {
					reported = done
					onProgress?.({
						step: 'download-wsl',
						phase: 'progress',
						done,
						total: pinned.sizeBytes,
						unit: 'bytes',
					})
				}
			}
		} catch (error) {
			if (signal?.aborted) throw signal.reason
			throw new RetryableError(error instanceof Error ? error.message : 'The download broke off.')
		}
	} finally {
		await handle.close()
	}
	onProgress?.({
		step: 'download-wsl',
		phase: 'progress',
		done,
		total: pinned.sizeBytes,
		unit: 'bytes',
	})
	if (done < pinned.sizeBytes) throw new RetryableError('The download ended early.')
}

/**
 * Fetch the pinned package into `directory/<file name>.part` (resuming it with
 * a Range request when a partial file exists), check the SHA-256, and
 * rename it to `directory/<file name>`. A file that fails the check is
 * deleted. Network trouble and 5xx answers retry with exponential backoff; a
 * 4xx answer fails at once. Emits only `progress` events; the caller owns
 * `started` and `finished`. An aborted signal rejects with the signal's reason
 * and leaves the partial file for the next run.
 */
export const downloadWslPackage: DownloadWslPackage = async (options) => {
	const { pinned, directory, signal, onProgress } = options
	const fetchImpl = options.fetch ?? fetch
	let target: string
	try {
		target = join(directory, fileNameOf(pinned.url))
	} catch (error) {
		return { outcome: 'failed', code: 'download-failed', detail: (error as Error).message }
	}
	const part = `${target}.part`
	await mkdir(directory, { recursive: true })

	// A previous run may have left a finished, verified file.
	if (
		(await sizeOf(target)) === pinned.sizeBytes &&
		(await sha256Of(target, signal)) === pinned.sha256
	) {
		return { outcome: 'ok', path: target }
	}
	await rm(target, { force: true })

	let lastError = 'The download failed.'
	for (let n = 0; n < MAX_ATTEMPTS; n++) {
		signal?.throwIfAborted()
		if (n > 0) await sleep(BASE_DELAY_MS * 2 ** (n - 1), signal)
		try {
			await attempt(pinned, part, fetchImpl, onProgress, signal)
		} catch (error) {
			if (signal?.aborted) throw signal.reason
			if (error instanceof FatalError) {
				return { outcome: 'failed', code: 'download-failed', detail: error.message }
			}
			if (error instanceof RetryableError) {
				lastError = error.message
				continue
			}
			return {
				outcome: 'failed',
				code: 'download-failed',
				detail: 'The package could not be written to disk.',
			}
		}
		// The digest decides; a file of the wrong length cannot have the right one.
		if ((await sha256Of(part, signal)) !== pinned.sha256) {
			await rm(part, { force: true })
			return {
				outcome: 'failed',
				code: 'download-corrupt',
				detail: 'The downloaded package does not match the release Namzu expects.',
			}
		}
		await rename(part, target)
		return { outcome: 'ok', path: target }
	}
	return { outcome: 'failed', code: 'download-failed', detail: lastError }
}
