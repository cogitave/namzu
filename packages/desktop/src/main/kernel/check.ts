import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ArchiveError, extractArchive } from './archive.js'
import { type ExpectedKernel, FactsError, parseKernelFacts } from './facts.js'
import { verifyFolderFully } from './files-list.js'
import { isAllowedFeedUrl } from './keys.js'
import { scrub } from './log.js'
import type { KernelManager } from './manager.js'
import {
	type BundleEntry,
	type KernelManifest,
	MAX_MANIFEST_BYTES,
	ManifestError,
	bundleKey,
	verifyManifest,
} from './manifest.js'
import { type KernelState, leftEngineUnfetched, versionFolder } from './state.js'
import { markBadIn, messageOf } from './store.js'
import { compareKernelVersions } from './version.js'

/**
 * The background check (section 5.2) as one function over injected effects. It never touches
 * `current`; its only lasting effects are the facts it learned from a signed manifest and, at
 * the end, a new `pending`.
 */

export interface FeedResponse {
	status: number
	body: AsyncIterable<Uint8Array> | null
	/** The address after redirects, when known. */
	url?: string
}

export type FeedFetch = (
	url: string,
	init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FeedResponse>

export type SkipReason = 'no-key' | 'disabled' | 'override' | 'unavailable'

export type FailureStage =
	| 'fetch'
	| 'signature'
	| 'manifest'
	| 'replay'
	| 'channel'
	| 'download'
	| 'extract'
	| 'verify'
	| 'self-check'
	| 'install'

export type CheckResult =
	| { kind: 'skipped'; reason: SkipReason }
	| { kind: 'current' }
	| { kind: 'ready'; version: string; engine: string }
	| { kind: 'needs-newer-app'; version: string; engine: string }
	| { kind: 'stale' }
	| { kind: 'failed'; stage: FailureStage; message: string; version?: string }

export interface CheckDeps {
	manager: KernelManager
	/** The folder the manifest is served from, ending with a slash. */
	feedBase: string
	channel: string
	fetch: FeedFetch
	now: () => number
	/**
	 * Runs the unpacked engine as a program in a clean environment and compares it to what the
	 * manifest promised (see `checkHostAnswer`). Returns the problem, or undefined when it passed.
	 */
	selfCheck: (args: {
		folder: string
		entry: string
		expected: ExpectedKernel
	}) => Promise<string | undefined>
	signal?: AbortSignal
}

const USER_AGENT = 'namzu-desktop'

/** After a failed download or store of one engine version, the same version waits this long (per run). */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/** What the self-check says when the engine did not answer in time; not a verdict on the engine. */
export const SELF_CHECK_TIMEOUT_TEXT = 'did not answer in time'

class Stop extends Error {
	/** The engine version the stop is about, once known. */
	version?: string
	constructor(
		readonly stage: FailureStage,
		message: string,
		/** true: given up with the stop's text; 'own': given up as the person's choice. */
		readonly markBad: boolean | 'own' = false,
	) {
		super(message)
	}
}

/** A version that failed to download or store a short while ago: waiting, not a new failure. */
class Waiting extends Stop {
	constructor(stage: FailureStage, message: string, version: string) {
		super(stage, message)
		this.version = version
	}
}

async function readCapped(
	body: AsyncIterable<Uint8Array>,
	max: number,
	stage: FailureStage,
): Promise<Buffer> {
	const parts: Buffer[] = []
	let total = 0
	for await (const chunk of body) {
		total += chunk.length
		if (total > max) throw new Stop(stage, 'The answer is larger than allowed.')
		parts.push(Buffer.from(chunk))
	}
	return Buffer.concat(parts)
}

async function get(deps: CheckDeps, url: string): Promise<FeedResponse> {
	if (!isAllowedFeedUrl(url)) throw new Stop('fetch', 'The update address is not allowed.')
	let response: FeedResponse
	try {
		response = await deps.fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
			...(deps.signal ? { signal: deps.signal } : {}),
		})
	} catch (error) {
		throw new Stop('fetch', `Could not reach the update address (${messageOf(error)}).`)
	}
	if (response.url !== undefined && !isAllowedFeedUrl(response.url))
		throw new Stop('fetch', 'The update address sent the request somewhere that is not allowed.')
	if (response.status !== 200 || !response.body)
		throw new Stop('fetch', `The update address answered ${response.status}.`)
	return response
}

function newest(a: string | undefined, b: string): string {
	return a === undefined || compareKernelVersions(b, a) > 0 ? b : a
}

/** Downloads with the exact size as the cap and sha512 computed on the way in. */
async function download(
	deps: CheckDeps,
	url: string,
	entry: BundleEntry,
	into: string,
): Promise<void> {
	const response = await get(deps, url)
	const { fs } = deps.manager.store
	const sink = await fs.openWrite(into)
	const hash = createHash('sha512')
	let count = 0
	try {
		for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
			count += chunk.length
			if (count > entry.size)
				throw new Stop('download', 'The download is larger than the manifest says.')
			hash.update(chunk)
			await sink.write(chunk)
			if (deps.signal?.aborted) throw new Stop('download', 'The download was cancelled.')
		}
	} finally {
		await sink.close()
	}
	if (count !== entry.size) throw new Stop('download', 'The download ended early.')
	if (hash.digest('hex') !== entry.sha512)
		throw new Stop('download', 'The download does not match its hash.')
}

async function emptyTmp(deps: CheckDeps): Promise<void> {
	const { fs, paths } = deps.manager.store
	await fs.rm(paths.tmp)
	await fs.mkdir(paths.tmp, { recursive: true })
}

/** Why no check ran, or undefined when one may. */
async function skipReason(deps: CheckDeps): Promise<SkipReason | undefined> {
	const { options } = deps.manager
	if (options.keys.length === 0) return 'no-key'
	if (options.override()) return 'override'
	if (!options.enabled()) return 'disabled'
	if (!(await options.bundledFacts())) return 'unavailable'
	return undefined
}

export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
	const skipped = await skipReason(deps)
	if (skipped) return { kind: 'skipped', reason: skipped }
	const { store } = deps.manager
	const freshBefore = store.snapshot().lastFreshCheckAt
	let waiting = false
	const result = await attempt(deps).catch((error): CheckResult => {
		if (error instanceof Waiting) waiting = true
		return error instanceof Stop
			? {
					kind: 'failed',
					stage: error.stage,
					message: error.message,
					...(error.version ? { version: error.version } : {}),
				}
			: { kind: 'failed', stage: 'install', message: messageOf(error) }
	})
	await store
		.update((state) => {
			// Waiting out an earlier failure changes nothing: the earlier record, with its time, stands.
			if (waiting) {
				state.lastFreshCheckAt = freshBefore
				return
			}
			state.lastCheck = {
				at: deps.now(),
				kind: result.kind,
				...(result.kind === 'failed'
					? {
							problem: scrub(result.message),
							stage: result.stage,
						}
					: {}),
			}
			// A newer engine is known to exist and could not be fetched or stored: that is not a fresh,
			// successful check, so the screen must not read "up to date" because of it (a full disk or a
			// proxy that cuts the download would otherwise look current until the staleness window ends).
			if (result.kind === 'failed' && leftEngineUnfetched(result.stage))
				state.lastFreshCheckAt = freshBefore
		})
		.catch(() => undefined)
	store.log('check', {
		result: waiting ? 'waiting' : result.kind,
		...(result.kind === 'failed' ? { stage: result.stage, message: result.message } : {}),
	})
	await emptyTmp(deps).catch(() => undefined)
	await deps.manager.cleanup().catch(() => undefined)
	return result
}

async function attempt(deps: CheckDeps): Promise<CheckResult> {
	const { manager } = deps
	const { store, options } = manager
	const bundled = await options.bundledFacts()
	if (!bundled) return { kind: 'skipped', reason: 'unavailable' }
	const ownChoices = manager.ownEngineChoices
	try {
		await emptyTmp(deps)
	} catch (error) {
		throw new Stop('install', `Could not prepare the download folder (${messageOf(error)}).`)
	}

	// 2. the manifest and its signature
	const manifestName = `kernel-${deps.channel}.json`
	const manifestResponse = await get(deps, new URL(manifestName, deps.feedBase).href)
	const manifestBytes = await readCapped(
		manifestResponse.body as AsyncIterable<Uint8Array>,
		MAX_MANIFEST_BYTES,
		'fetch',
	)
	const signatureResponse = await get(deps, new URL(`${manifestName}.sig`, deps.feedBase).href)
	const signatureBytes = await readCapped(
		signatureResponse.body as AsyncIterable<Uint8Array>,
		MAX_MANIFEST_BYTES,
		'fetch',
	)

	// 3. signature, strict parse, channel, sequence
	let manifest: KernelManifest
	try {
		manifest = verifyManifest(manifestBytes, signatureBytes, options.keys).manifest
	} catch (error) {
		if (error instanceof ManifestError)
			throw new Stop(error.code === 'manifest-format' ? 'manifest' : 'signature', error.message)
		throw error
	}
	if (manifest.channel !== deps.channel)
		throw new Stop('channel', 'The answer is for another channel.')
	const stored = await manager.storedTrust()
	const before = store.snapshot()
	before.lastSequence = Math.max(before.lastSequence, stored.sequence)
	before.highestIssuedAt = Math.max(before.highestIssuedAt, stored.issuedAt)
	if (manifest.sequence < before.lastSequence)
		throw new Stop('replay', 'The answer is older than one already seen.')

	// 4. freshness, without trusting the local clock
	const now = deps.now()
	const trustedNow = Math.max(now, before.highestIssuedAt, manifest.issuedAt)
	const fresh = manifest.expiresAt >= trustedNow

	// 5. what a signed manifest teaches, never lowered
	await store.update((state) => {
		state.lastSequence = Math.max(state.lastSequence, manifest.sequence)
		state.highestIssuedAt = Math.max(state.highestIssuedAt, manifest.issuedAt)
		state.minimumKernel = newest(state.minimumKernel, manifest.minimumKernel)
		if (stored.minimumKernel)
			state.minimumKernel = newest(state.minimumKernel, stored.minimumKernel)
		if (fresh) state.lastFreshCheckAt = now
		for (const version of manifest.withdrawn)
			if (!state.bad[version]) markBadIn(state, version, 'withdrawn', now)
	})
	if (!fresh) return { kind: 'stale' }

	// 6. is there a candidate
	const state = store.snapshot()
	const version = manifest.kernel.commandLine
	const bundle = manifest.kernel.bundles[bundleKey(options.platform, options.arch)]
	if (!bundle) return { kind: 'current' }
	const floor = state.minimumKernel ?? manifest.minimumKernel
	const newerThan = (other: string | undefined) =>
		other === undefined || compareKernelVersions(version, other) > 0
	if (!newerThan(bundled.commandLine) || !newerThan(state.current)) return { kind: 'current' }
	if (compareKernelVersions(version, floor) < 0) return { kind: 'current' }
	if (state.bad[version]) return { kind: 'current' }
	const [low, high] = options.contractRange
	if (
		manifest.kernel.desktopContract < low ||
		manifest.kernel.desktopContract > high ||
		manifest.kernel.dataEpoch !== bundled.dataEpoch
	)
		return { kind: 'needs-newer-app', version, engine: manifest.kernel.engine }
	if (state.pending && compareKernelVersions(version, state.pending) <= 0) {
		const quick = await manager.quickCheck(state.pending, bundled)
		if (quick.ok) return { kind: 'ready', version: state.pending, engine: quick.engine }
		await store.markBad(state.pending, quick.reason)
	}

	// 7 to 9. fetch, unpack, check, make pending
	// A version whose download or storing failed is not fetched again at every check: a full disk or a
	// connection that cuts a 27 MB download would otherwise repeat it every four hours.
	// The memory is per run of the app: a restart tries once again.
	const failed = manager.fetchFailures.get(version)
	if (failed && deps.now() - failed.at < RETRY_AFTER_MS)
		throw new Waiting(failed.stage, failed.message, version)
	try {
		await install(deps, manifest, bundle, version, { manifestBytes, signatureBytes }, ownChoices)
	} catch (error) {
		const stop = error instanceof Stop ? error : new Stop('install', messageOf(error))
		stop.version ??= version
		if (stop.stage === 'download' || stop.stage === 'install')
			manager.fetchFailures.set(version, {
				at: deps.now(),
				stage: stop.stage,
				message: stop.message,
			})
		throw stop
	}
	return { kind: 'ready', version, engine: manifest.kernel.engine }
}

async function install(
	deps: CheckDeps,
	manifest: KernelManifest,
	bundle: BundleEntry,
	version: string,
	pair: { manifestBytes: Buffer; signatureBytes: Buffer },
	ownChoices: number,
): Promise<void> {
	const { store, options } = deps.manager
	const { fs, paths } = store
	// Fixed names: a file name from the signed description never names a path here.
	const archive = join(paths.tmp, 'download.tar.gz')
	const unpacked = join(paths.tmp, 'unpacked')
	const expected: ExpectedKernel = {
		commandLine: manifest.kernel.commandLine,
		engine: manifest.kernel.engine,
		desktopContract: manifest.kernel.desktopContract,
		dataEpoch: manifest.kernel.dataEpoch,
	}
	let moved = false
	try {
		await download(deps, new URL(bundle.file, deps.feedBase).href, bundle, archive)
		let list: Awaited<ReturnType<typeof extractArchive>>['list']
		try {
			;({ list } = await extractArchive({
				source: fs.openRead(archive),
				target: unpacked,
				fs,
				limits: {
					fileCount: bundle.fileCount,
					unpackedSize: bundle.unpackedSize,
					filesSha512: bundle.filesSha512,
				},
			}))
		} catch (error) {
			if (error instanceof ArchiveError)
				throw new Stop(
					'extract',
					`The engine archive was refused (${error.code}: ${error.message}).`,
					true,
				)
			throw error
		}
		const problem = await verifyFolderFully(fs, unpacked, list)
		if (problem)
			throw new Stop('verify', `The unpacked engine does not match its list (${problem}).`, true)
		try {
			let factsBytes: Buffer
			try {
				factsBytes = await fs.readFile(join(unpacked, 'kernel.json'))
			} catch {
				throw new Stop('verify', 'The engine carries no kernel.json.', true)
			}
			const facts = parseKernelFacts(factsBytes)
			if (
				facts.commandLine !== expected.commandLine ||
				facts.engine !== expected.engine ||
				facts.desktopContract !== expected.desktopContract ||
				facts.dataEpoch !== expected.dataEpoch ||
				facts.platform !== options.platform ||
				facts.arch !== options.arch
			)
				throw new Stop('verify', 'kernel.json does not agree with the manifest.', true)
		} catch (error) {
			if (error instanceof FactsError) throw new Stop('verify', error.message, true)
			throw error
		}
		await fs.rm(archive)
		moved = true
		await store.installFolder(version, unpacked, {
			manifest: pair.manifestBytes,
			signature: pair.signatureBytes,
		})
		const folder = versionFolder(paths, version)
		let selfProblem: string | undefined
		try {
			selfProblem = await deps.selfCheck({
				folder,
				entry: join(folder, 'dist', 'bin.js'),
				expected,
			})
		} catch (error) {
			selfProblem = messageOf(error)
		}
		if (selfProblem)
			throw new Stop(
				'self-check',
				`The engine failed its own check (${selfProblem}).`,
				// A check that ran out of time says nothing against the engine; a later check tries again.
				!selfProblem.includes(SELF_CHECK_TIMEOUT_TEXT),
			)
		// The person may have chosen the app's own engine, or turned the setting off, while this ran.
		if (deps.manager.ownEngineChoices !== ownChoices)
			throw new Stop('install', 'The person chose this app’s own engine meanwhile.', 'own')
		if (deps.signal?.aborted || !deps.manager.active)
			throw new Stop('install', 'The check was stopped before the engine was made ready.')
		const saved = await store.update((state: KernelState) => {
			state.pending = version
		})
		if (!saved) throw new Stop('install', 'Could not record the new engine.')
	} catch (error) {
		if (error instanceof Stop && error.markBad === 'own')
			await store.markBad(version, 'the person chose this app’s own engine')
		else if (error instanceof Stop && error.markBad) await store.markBad(version, error.message)
		if (moved) await store.removeVersion(version).catch(() => undefined)
		throw error
	} finally {
		store.finishInstall(version)
	}
}

/** Runs `check` so that a second call while one runs gets the same answer. */
export function singleFlight(check: () => Promise<CheckResult>): () => Promise<CheckResult> {
	let running: Promise<CheckResult> | undefined
	return () => {
		running ??= check().finally(() => {
			running = undefined
		})
		return running
	}
}
