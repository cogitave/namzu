/**
 * The Zen and Zen Go model catalogue this CLI session routes and lists with.
 *
 * `@namzu/zen` ships a bundled snapshot and never fetches on its own. The CLI
 * opts in: every launch starts one background refresh (`startZenCatalogueRefresh`)
 * that is never awaited on the startup path, is bounded in time, and is
 * cancelled when the command returns. Until it lands the session uses the
 * last-good copy under the application home, or — with none — the bundled
 * snapshot. A refresh that lands becomes the active catalogue at once and is
 * written as the new last-good copy; a refresh that fails changes nothing and
 * says so in one log line. There is no state in between: a catalogue is either
 * the whole of a validated derivation or it is not used.
 *
 * Every Zen provider the CLI builds reads `activeZenCatalogue` at each lookup
 * (`ZenConfig.catalogue` as a function), so a catalogue that lands mid-session
 * reaches providers that were built before it.
 */

import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Logger } from '@namzu/sdk'
import {
	type ZenCatalogue,
	type ZenCatalogueResult,
	fetchZenCatalogue,
	findZenCatalogueModel,
	isUnroutedZenModel,
	parseZenCatalogue,
} from '@namzu/zen/catalogue'
import type { ZenModel, ZenService } from '@namzu/zen/models'

/** Where the last-good catalogue lives, relative to the application home. */
export const ZEN_CATALOGUE_CACHE_PATH = join('cli', 'zen-catalogue.json')

/** The whole refresh — five reads and the derivation — gets this long, then stops. */
export const ZEN_CATALOGUE_REFRESH_BUDGET_MS = 30_000

/**
 * A last-good copy written within this long is used as it is and the network
 * is not asked again. Several CLI processes start together (the Desktop runs
 * one per open project), and without this each one fetches the same five
 * sources.
 */
export const ZEN_CATALOGUE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** A stored catalogue past this is refused unread. The live one serialises to ~40 KB. */
const MAX_CACHE_BYTES = 4 * 1024 * 1024

/** Which catalogue the session is using. */
export type ZenCatalogueSource = 'bundled' | 'cache' | 'live'

let active: ZenCatalogue | undefined
let activeSource: ZenCatalogueSource = 'bundled'

/** The runtime catalogue this session routes with, or undefined for the bundled snapshot. */
export function activeZenCatalogue(): ZenCatalogue | undefined {
	return active
}

/** Where the active catalogue came from. */
export function activeZenCatalogueSource(): ZenCatalogueSource {
	return activeSource
}

/** Exact lookup against the active catalogue, falling back to the bundled snapshot. */
export function findActiveZenModel(service: ZenService, id: string): ZenModel | undefined {
	return findZenCatalogueModel(active, service, id)
}

/**
 * Whether the CLI can offer `model` on `providerId` — false only for a Zen or
 * Zen Go id the active catalogue lists as served with no known wire format.
 *
 * `ZenProvider.listModels` lists such an id so that an embedder, who can pass
 * `protocol`, can see it. The CLI has no key or flag that names a protocol, so
 * choosing one would fail on every turn with a remedy the operator cannot
 * apply; the CLI's listings leave it out instead.
 */
export function isOfferableModel(providerId: string, model: string): boolean {
	const service: ZenService | undefined =
		providerId === 'zen' ? 'zen' : providerId === 'zen-go' ? 'go' : undefined
	return service === undefined || !isUnroutedZenModel(active, service, model)
}

/** Test seam: back to the bundled snapshot. */
export function __resetZenCatalogueForTests(): void {
	active = undefined
	activeSource = 'bundled'
}

/** How a refresh ended. `cancelled` is the launch ending first, which is not a failure. */
export type ZenCatalogueRefreshOutcome =
	| { readonly kind: 'live'; readonly catalogue: ZenCatalogue }
	| { readonly kind: 'fresh-cache'; readonly catalogue: ZenCatalogue }
	| { readonly kind: 'failed'; readonly using: 'cache' | 'bundled'; readonly reason: string }
	| { readonly kind: 'cancelled' }

export interface ZenCatalogueRefresh {
	/** Settles when the refresh does. Never rejects. */
	readonly done: Promise<ZenCatalogueRefreshOutcome>
	/** Stop now. Idempotent; a refresh that already landed is kept. */
	cancel(): void
}

export interface StartZenCatalogueRefreshOptions {
	/** The application home (`NAMZU_HOME`, default `~/.namzu`). */
	readonly home: string
	/**
	 * Where the refresh's lines go. A function is called for each line, and the
	 * CLI passes `cliLogger` itself: the process logger is rebuilt when the TUI
	 * installs its ring buffer or `exec --json` its NDJSON sink, both after the
	 * refresh starts, and a logger captured at start would keep writing to the
	 * sink that was current then — raw lines under Ink, pretty lines on a
	 * machine-read stderr.
	 */
	readonly log: Logger | (() => Logger)
	/** Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch
	/** Defaults to `ZEN_CATALOGUE_REFRESH_BUDGET_MS`. */
	readonly budgetMs?: number
	/** How recent a last-good copy must be to skip the network. Defaults to `ZEN_CATALOGUE_CACHE_MAX_AGE_MS`; 0 always fetches. */
	readonly cacheMaxAgeMs?: number
	/** Test seam for the clock the cache age is measured on. Defaults to `Date.now`. */
	readonly now?: () => number
	/** Test seam for the derivation; defaults to `@namzu/zen/catalogue`'s `fetchZenCatalogue`. */
	readonly fetchCatalogue?: (options: {
		readonly fetch?: typeof fetch
		readonly signal: AbortSignal
		readonly timeoutMs: number
	}) => Promise<ZenCatalogueResult>
}

/**
 * Start the launch's background refresh and return at once.
 *
 * Synchronous by contract: nothing here is awaited before the handle is
 * returned, so the caller's startup path cannot wait on the network or the
 * disk. The last-good copy is read first and adopted if no live catalogue has
 * landed by then; the network result, when it lands, replaces it.
 */
export function startZenCatalogueRefresh(
	options: StartZenCatalogueRefreshOptions,
): ZenCatalogueRefresh {
	const controller = new AbortController()
	const budget = options.budgetMs ?? ZEN_CATALOGUE_REFRESH_BUDGET_MS
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(budget)])
	const cachePath = join(options.home, ZEN_CATALOGUE_CACHE_PATH)
	const source = options.log
	const log = (): Logger => (typeof source === 'function' ? source() : source)
	let landed = false

	const run = async (): Promise<ZenCatalogueRefreshOutcome> => {
		// Yield before touching anything, so even the synchronous prelude of a
		// file read or a fetch happens after the caller has its handle back.
		await Promise.resolve()
		let freshCopy: ZenCatalogue | undefined
		// The last-good read is awaited before the fetch (one small file read
		// ahead of every refresh) so a fresh copy can skip the network entirely.
		const cached = readLastGood(cachePath, log).then((copy) => {
			if (copy && !landed && !controller.signal.aborted) {
				active = copy.catalogue
				activeSource = 'cache'
				const age = (options.now ?? Date.now)() - copy.writtenAtMs
				if (age >= 0 && age < (options.cacheMaxAgeMs ?? ZEN_CATALOGUE_CACHE_MAX_AGE_MS)) {
					freshCopy = copy.catalogue
				}
			}
		})
		try {
			signal.throwIfAborted()
			await cached
			if (freshCopy) {
				log().debug('Zen model catalogue last-good copy is recent; not fetching', {
					'namzu.zen_catalogue.cache_path': cachePath,
				})
				return { kind: 'fresh-cache', catalogue: freshCopy }
			}
			const fetchCatalogue = options.fetchCatalogue ?? fetchZenCatalogue
			const { catalogue } = await fetchCatalogue({
				...(options.fetch ? { fetch: options.fetch } : {}),
				signal,
				timeoutMs: Math.min(budget, 15_000),
			})
			signal.throwIfAborted()
			landed = true
			active = catalogue
			activeSource = 'live'
			await writeLastGood(cachePath, catalogue).catch((error: unknown) => {
				log().warn('Zen model catalogue refreshed but the last-good copy was not written', {
					'namzu.zen_catalogue.cache_path': cachePath,
					'namzu.zen_catalogue.reason': errorText(error),
				})
			})
			log().debug('Zen model catalogue refreshed', {
				'namzu.zen_catalogue.zen_models': catalogue.zen.length,
				'namzu.zen_catalogue.go_models': catalogue.go.length,
			})
			return { kind: 'live', catalogue }
		} catch (error) {
			await cached
			if (controller.signal.aborted) return { kind: 'cancelled' }
			const using = activeSource === 'cache' ? 'cache' : 'bundled'
			const reason = signal.aborted
				? `the refresh did not finish within ${budget}ms`
				: errorText(error)
			// Offline, a blocked host or a slow answer is a normal state for a
			// desktop app: the session runs on the catalogue it has, and the
			// reason is on the debug line for whoever asks. Anything else — a
			// source that moved or no longer parses — is a defect and stays a
			// warning.
			const attributes = {
				'namzu.zen_catalogue.using': using,
				'namzu.zen_catalogue.reason': reason,
			}
			const message = 'Zen model catalogue refresh failed; keeping the catalogue already in use'
			if (isConnectivityFailure(signal.aborted, reason)) log().debug(message, attributes)
			else log().warn(message, attributes)
			return { kind: 'failed', using, reason }
		}
	}

	const done = run().catch(
		(error: unknown): ZenCatalogueRefreshOutcome => ({
			kind: 'failed',
			using: activeSource === 'cache' ? 'cache' : 'bundled',
			reason: errorText(error),
		}),
	)
	return {
		done,
		cancel: () => controller.abort(new Error('The launch ended before the Zen catalogue refresh.')),
	}
}

/** The last-good copy, or undefined — one log line when one exists and is refused. */
async function readLastGood(
	path: string,
	log: () => Logger,
): Promise<{ readonly catalogue: ZenCatalogue; readonly writtenAtMs: number } | undefined> {
	let text: string
	let writtenAtMs: number
	try {
		const handle = await open(path, 'r')
		try {
			const { size, mtimeMs } = await handle.stat()
			writtenAtMs = mtimeMs
			if (size > MAX_CACHE_BYTES) throw new Error(`it is ${size} bytes, past ${MAX_CACHE_BYTES}`)
			text = await handle.readFile('utf8')
		} finally {
			await handle.close()
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined
		log().warn('Zen model catalogue last-good copy could not be read; ignoring it', {
			'namzu.zen_catalogue.cache_path': path,
			'namzu.zen_catalogue.reason': errorText(error),
		})
		return undefined
	}
	try {
		return { catalogue: parseZenCatalogue(JSON.parse(text)), writtenAtMs }
	} catch (error) {
		log().warn('Zen model catalogue last-good copy is not a valid catalogue; ignoring it', {
			'namzu.zen_catalogue.cache_path': path,
			'namzu.zen_catalogue.reason': errorText(error),
		})
		return undefined
	}
}

/**
 * Write the last-good copy atomically: a sibling temp file, then a rename, so
 * a reader — this launch's next start, or a concurrent one — sees the old copy
 * or the new one and never a torn write.
 */
export async function writeLastGood(path: string, catalogue: ZenCatalogue): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`
	try {
		const handle = await open(temp, 'wx', 0o600)
		try {
			await handle.writeFile(`${JSON.stringify(catalogue)}\n`, 'utf8')
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(temp, path)
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

/**
 * A refresh that could not reach its sources, as opposed to one that reached
 * them and found them wrong. `readZenSource` words the first as "could not be
 * read after N attempt(s)" and the budget running out is the other.
 */
function isConnectivityFailure(timedOut: boolean, reason: string): boolean {
	if (timedOut) return true
	const unread = /could not be read after \d+ attempts?: (.*)$/s.exec(reason)
	// A source that answered with a status (403, 429, 5xx) was reached and is
	// wrong; only a failed or timed-out request is a connectivity failure.
	return unread !== null && !/ answered \d{3}\./.test(unread[1] ?? '')
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}
