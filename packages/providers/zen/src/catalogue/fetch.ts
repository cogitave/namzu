/**
 * Reading the Zen catalogue's sources over the network — the one module in
 * this package that does, and only when a caller invokes it. Importing it,
 * constructing a provider or reading the bundled snapshot fetches nothing.
 */

import type { ZenService } from '../models.js'
import {
	type BuildZenCatalogueOptions,
	type ZenCatalogueResult,
	type ZenCatalogueSources,
	buildZenCatalogue,
} from './catalogue.js'
import { SERVICE_PREFIX, ZenCatalogueSourceError } from './derive.js'

/** The branch of OpenCode's repository the two documentation pages are read from. */
export const ZEN_DOCS_REF = 'dev'
export const ZEN_MODELS_DEV_URL = 'https://models.dev/api.json'
/** The host both services' own `/models` endpoints hang off. */
export const ZEN_SERVICE_BASE = 'https://opencode.ai'

/** Byte ceilings per source. A source past its ceiling is refused, never truncated. */
export interface ZenCatalogueLimits {
	/** Each documentation page. Default 1 MiB (the live pages are ~32 KB). */
	readonly pageBytes?: number
	/** models.dev's whole document. Default 32 MiB (measured 4.8 MB on 2026-09-22). */
	readonly modelsDevBytes?: number
	/** Each `/models` answer. Default 1 MiB, the driver's own `listModels` ceiling. */
	readonly servedBytes?: number
}

export interface FetchZenCatalogueOptions {
	/** Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch
	/** Aborts every outstanding read; the call then rejects with the signal's reason. */
	readonly signal?: AbortSignal
	/** Deadline for each source read, in milliseconds. Default 15,000. */
	readonly timeoutMs?: number
	/** Tries per source; a 404 is never retried. Default 1. */
	readonly attempts?: number
	readonly limits?: ZenCatalogueLimits
	/** OpenCode branch for the two pages. Default `dev`. */
	readonly docsRef?: string
	readonly modelsDevUrl?: string
	/** Host for the two `/models` answers. Default `https://opencode.ai`. */
	readonly serviceBase?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MIB = 1024 * 1024

function docsBase(ref: string): string {
	return `https://raw.githubusercontent.com/anomalyco/opencode/${encodeURIComponent(ref)}/packages/web/src/content/docs`
}

/** The models-list endpoint of one service. */
export function zenServedUrl(service: ZenService, serviceBase = ZEN_SERVICE_BASE): string {
	return `${serviceBase.replace(/\/+$/, '')}${SERVICE_PREFIX[service]}models`
}

function positive(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${name} must be a positive integer.`)
	return value
}

async function readBounded(response: Response, limit: number, url: string): Promise<string> {
	const declared = Number(response.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => {})
		throw new ZenCatalogueSourceError(
			`${url} declares ${declared} bytes, past its ${limit}-byte limit.`,
		)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new ZenCatalogueSourceError(`${url} answered with no body.`)
	const chunks: Uint8Array[] = []
	let bytes = 0
	try {
		while (true) {
			const next = await reader.read()
			if (next.done) break
			bytes += next.value.byteLength
			if (bytes > limit) {
				throw new ZenCatalogueSourceError(`${url} exceeds its ${limit}-byte limit.`)
			}
			chunks.push(next.value)
		}
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
	const body = new Uint8Array(bytes)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(body)
	} catch {
		throw new ZenCatalogueSourceError(`${url} is not UTF-8 text.`)
	}
}

/**
 * One source, as text, inside its deadline and its byte ceiling.
 *
 * Redirects are refused: every source is a fixed URL that answers directly, and
 * a source that starts redirecting has moved. A 404 is a branch or a path that
 * moved and is not retried; a caller's abort is not retried either.
 */
export async function readZenSource(
	url: string,
	limit: number,
	options: Pick<FetchZenCatalogueOptions, 'fetch' | 'signal' | 'timeoutMs' | 'attempts'> = {},
): Promise<string> {
	const fetchFn = options.fetch ?? globalThis.fetch
	const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
	const attempts = positive(options.attempts, 1, 'attempts')
	let lastError: unknown
	for (let attempt = 1; attempt <= attempts; attempt++) {
		options.signal?.throwIfAborted()
		try {
			const signal = AbortSignal.any([
				AbortSignal.timeout(timeoutMs),
				...(options.signal ? [options.signal] : []),
			])
			const response = await fetchFn(url, { signal, redirect: 'error' })
			if (response.ok) return await readBounded(response, limit, url)
			await response.body?.cancel().catch(() => {})
			if (response.status === 404) {
				throw new ZenCatalogueSourceError(`${url} answered 404 — the branch or the path moved.`)
			}
			throw new Error(`${url} answered ${response.status}.`)
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason
			if (error instanceof ZenCatalogueSourceError) throw error
			lastError = error
			if (attempt < attempts) await delay(500 * attempt, options.signal)
		}
	}
	throw new ZenCatalogueSourceError(
		`${url} could not be read after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	)
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, ms)
		function done() {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}
		function onAbort() {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

/** The two `/models` answers, as text. */
export async function fetchZenServedRosters(
	options: FetchZenCatalogueOptions = {},
): Promise<Record<ZenService, string>> {
	const limit = positive(options.limits?.servedBytes, MIB, 'limits.servedBytes')
	const [zen, go] = await Promise.all([
		readZenSource(zenServedUrl('zen', options.serviceBase), limit, options),
		readZenSource(zenServedUrl('go', options.serviceBase), limit, options),
	])
	return { zen, go }
}

/**
 * All five sources, as text: the two documentation pages, models.dev and the
 * two `/models` answers. Rejects on the first source that cannot be read.
 */
export async function fetchZenCatalogueSources(
	options: FetchZenCatalogueOptions = {},
): Promise<ZenCatalogueSources> {
	const pageLimit = positive(options.limits?.pageBytes, MIB, 'limits.pageBytes')
	const modelsDevLimit = positive(options.limits?.modelsDevBytes, 32 * MIB, 'limits.modelsDevBytes')
	const base = docsBase(options.docsRef ?? ZEN_DOCS_REF)
	const failFast = new AbortController()
	const scoped: FetchZenCatalogueOptions = {
		...options,
		signal: AbortSignal.any([failFast.signal, ...(options.signal ? [options.signal] : [])]),
	}
	const read = <T>(promise: Promise<T>): Promise<T> =>
		promise.catch((error) => {
			// One unreadable source decides the result, so the others stop
			// downloading rather than finishing for nothing.
			failFast.abort(error)
			throw error
		})
	try {
		const [zen, go, modelsDev, served] = await Promise.all([
			read(readZenSource(`${base}/zen.mdx`, pageLimit, scoped)),
			read(readZenSource(`${base}/go.mdx`, pageLimit, scoped)),
			read(readZenSource(options.modelsDevUrl ?? ZEN_MODELS_DEV_URL, modelsDevLimit, scoped)),
			read(fetchZenServedRosters(scoped)),
		])
		return { docs: { zen, go }, modelsDev, served }
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason
		// A sibling aborted by `failFast` rejects with the first failure as its
		// reason, which is the error worth reporting.
		throw failFast.signal.aborted ? failFast.signal.reason : error
	}
}

/**
 * Read every source and derive a catalogue from them, or reject.
 *
 * Opt-in by construction: nothing in this package calls it. A rejection is a
 * `ZenCatalogueSourceError` for a source that could not be read or no longer
 * parses, or the caller's abort reason; there is no partial result.
 */
export async function fetchZenCatalogue(
	options: FetchZenCatalogueOptions & BuildZenCatalogueOptions = {},
): Promise<ZenCatalogueResult> {
	const sources = await fetchZenCatalogueSources(options)
	options.signal?.throwIfAborted()
	return buildZenCatalogue(sources, options)
}
