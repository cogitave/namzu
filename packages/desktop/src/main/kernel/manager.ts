import { join } from 'node:path'
import { type BundledFacts, FactsError, parseKernelFacts } from './facts.js'
import {
	FilesListError,
	parseFilesList,
	sha512Hex,
	verifyFolderFully,
	verifyQuickFiles,
} from './files-list.js'
import type { KernelPublicKey } from './keys.js'
import { scrub } from './log.js'
import { ManifestError, bundleKey, verifyManifest } from './manifest.js'
import { type KernelState, pairPaths, versionFolder } from './state.js'
import { type KernelStore, markBadIn, messageOf } from './store.js'
import { compareKernelVersions, isKernelVersion } from './version.js'

/**
 * Choosing the engine for a host (section 5.3) and going back (section 5.4).
 *
 * Everything outside is passed in. Call `resolve()` at every spawn of a host, a terminal tab
 * or a short command. Report each host that was started on a managed engine with
 * `hostStarted`, and its end with `hostExited`, so a folder in use is never deleted and an
 * engine that keeps dying is given up.
 */

export type KernelSource = 'bundled' | 'managed' | 'override'

export interface ResolvedKernel {
	entry: string
	source: KernelSource
	/** The command line version of a managed engine. */
	version?: string
	/** The engine version of a managed engine (from its signed manifest). */
	engine?: string
	/** When the managed engine became the one in use. */
	updatedAt?: number
	/** Managed versions that were tried in this call and given up, newest first. */
	wentBack?: { version: string; reason: string }[]
	/** Present when the call asked to hold the folder: call it when the host no longer needs it. */
	release?: () => void
}

export interface ManagerOptions {
	store: KernelStore
	keys: readonly KernelPublicKey[]
	/** The bundled `dist/bin.js`. */
	bundledEntry: string
	bundledFacts: () => Promise<BundledFacts | undefined>
	platform: string
	arch: string
	contractRange: readonly [number, number]
	/** The setting "Keep the engine up to date". */
	enabled: () => boolean
	/** `NAMZU_DESKTOP_CLI`, when set. */
	override: () => string | undefined
}

export const EARLY_EXIT_MS = 10_000
const EARLY_EXIT_STARTS = 3
const EARLY_EXITS_TO_GIVE_UP = 2

/**
 * `transient` marks a failure to read (a file another program holds for a moment) rather than a
 * verdict on the engine: it is never a reason to give an engine up for good.
 */
export type QuickVerdict =
	| { ok: true; engine: string }
	| { ok: false; reason: string; transient?: true }

/** Error codes of a read that may work a moment later. */
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN', 'EIO'])

function isTransient(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code
	return typeof code === 'string' && TRANSIENT_CODES.has(code)
}

/** What the signed pairs kept on disk teach, whatever the state file says. */
export interface StoredTrust {
	sequence: number
	issuedAt: number
	minimumKernel?: string
}

export class KernelManager {
	private readonly live = new Map<string, number>()
	/** Versions whose whole folder was hashed in this run; later starts hash only the entry files. */
	private readonly fullyChecked = new Set<string>()
	private ownChoices = 0

	constructor(readonly options: ManagerOptions) {}

	get store(): KernelStore {
		return this.options.store
	}

	/** Versions that a live host was started from. */
	inUse(): ReadonlySet<string> {
		return new Set(this.live.keys())
	}

	/** Whether the feature may act at all: a key is compiled in, and the setting is on. */
	get active(): boolean {
		return this.options.keys.length > 0 && this.options.enabled()
	}

	/** How many times the person has chosen this app's own engine in this run. */
	get ownEngineChoices(): number {
		return this.ownChoices
	}

	/**
	 * The highest sequence, issue time and floor among the signed pairs on disk. The state file
	 * is writable by whoever can write the folder; a pair that still verifies is not, so what it
	 * says is never forgotten when the state file is lost or edited.
	 */
	async storedTrust(): Promise<StoredTrust> {
		const { store } = this.options
		const trust: StoredTrust = { sequence: 0, issuedAt: 0 }
		let names: string[]
		try {
			names = await store.fs.readdir(store.paths.versions)
		} catch {
			return trust
		}
		for (const name of names) {
			if (!name.endsWith('.manifest.json')) continue
			const version = name.slice(0, -'.manifest.json'.length)
			if (!isKernelVersion(version)) continue
			try {
				const pair = pairPaths(store.paths, version)
				const { manifest } = verifyManifest(
					await store.fs.readFile(pair.manifest),
					await store.fs.readFile(pair.signature),
					this.options.keys,
				)
				trust.sequence = Math.max(trust.sequence, manifest.sequence)
				trust.issuedAt = Math.max(trust.issuedAt, manifest.issuedAt)
				if (
					trust.minimumKernel === undefined ||
					compareKernelVersions(manifest.minimumKernel, trust.minimumKernel) > 0
				)
					trust.minimumKernel = manifest.minimumKernel
			} catch {
				// a pair that cannot be read or does not verify teaches nothing
			}
		}
		return trust
	}

	async quickCheck(version: string, bundled: BundledFacts): Promise<QuickVerdict> {
		const { store } = this.options
		const state = store.snapshot()
		const no = (reason: string, transient?: true): QuickVerdict => ({
			ok: false,
			reason,
			...(transient ? { transient } : {}),
		})
		if (state.bad[version]) return no(`already given up (${state.bad[version]?.reason})`)
		const stored = await this.storedTrust()
		const floor =
			state.minimumKernel && stored.minimumKernel
				? compareKernelVersions(state.minimumKernel, stored.minimumKernel) >= 0
					? state.minimumKernel
					: stored.minimumKernel
				: (state.minimumKernel ?? stored.minimumKernel)
		if (floor && compareKernelVersions(version, floor) < 0)
			return no('below the lowest allowed version')
		if (compareKernelVersions(version, bundled.commandLine) <= 0)
			return no('not newer than the bundled engine')
		try {
			const pair = pairPaths(store.paths, version)
			const manifestBytes = await store.fs.readFile(pair.manifest)
			const signatureBytes = await store.fs.readFile(pair.signature)
			const { manifest } = verifyManifest(manifestBytes, signatureBytes, this.options.keys)
			if (manifest.kernel.commandLine !== version)
				return no('the stored manifest is for another version')
			if (manifest.withdrawn.includes(version)) return no('withdrawn')
			const bundle = manifest.kernel.bundles[bundleKey(this.options.platform, this.options.arch)]
			if (!bundle) return no('the stored manifest has no copy for this computer')
			const [low, high] = this.options.contractRange
			if (manifest.kernel.desktopContract < low || manifest.kernel.desktopContract > high)
				return no('needs another version of this app')
			if (manifest.kernel.dataEpoch !== bundled.dataEpoch) return no('its data format differs')
			const folder = versionFolder(store.paths, version)
			const filesBytes = await store.fs.readFile(join(folder, 'files.json'))
			if (sha512Hex(filesBytes) !== bundle.filesSha512) return no('files.json changed')
			const list = parseFilesList(filesBytes)
			// The first start of a version in a run hashes every file and refuses an unlisted one;
			// later starts hash only the files that decide what runs.
			const checked = this.fullyChecked.has(version)
			const problem = checked
				? await verifyQuickFiles(store.fs, folder, list)
				: await verifyFolderFully(store.fs, folder, list)
			if (problem) return no(problem)
			const facts = parseKernelFacts(await store.fs.readFile(join(folder, 'kernel.json')))
			if (facts.platform !== this.options.platform || facts.arch !== this.options.arch)
				return no('built for another computer')
			if (
				facts.commandLine !== manifest.kernel.commandLine ||
				facts.engine !== manifest.kernel.engine ||
				facts.dataEpoch !== manifest.kernel.dataEpoch ||
				facts.desktopContract !== manifest.kernel.desktopContract
			)
				return no('kernel.json differs from the manifest')
			this.fullyChecked.add(version)
			return { ok: true, engine: manifest.kernel.engine }
		} catch (error) {
			if (
				error instanceof ManifestError ||
				error instanceof FilesListError ||
				error instanceof FactsError
			)
				return no(error.message)
			// Only the error code: the message carries paths of the person's computer.
			const code = (error as { code?: unknown } | null)?.code
			return no(
				`unreadable (${typeof code === 'string' ? code : 'error'})`,
				isTransient(error) ? true : undefined,
			)
		}
	}

	/**
	 * The engine a host starts from now. Promotes a pending engine; gives up bad ones. With
	 * `hold`, the folder of a managed engine is kept from this moment (before any clean-up) until
	 * `release` is called, so a host that is still starting never loses it.
	 */
	async resolve(options: { hold?: boolean } = {}): Promise<ResolvedKernel> {
		const override = this.options.override()
		if (override) return { entry: override, source: 'override' }
		const bundled: ResolvedKernel = { entry: this.options.bundledEntry, source: 'bundled' }
		if (!this.active) return bundled
		const facts = await this.options.bundledFacts()
		if (!facts) return bundled
		const { store } = this.options
		let changed = false
		if (store.snapshot().pending) {
			const at = store.now()
			await store.update((state) => {
				if (!state.pending) return
				state.previous = state.current
				state.previousUpdatedAt = state.current ? state.updatedAt : undefined
				state.current = state.pending
				state.updatedAt = at
				state.pending = undefined
			})
			changed = true
		}
		const wentBack: { version: string; reason: string }[] = []
		const tried = new Set<string>()
		for (;;) {
			const state = store.snapshot()
			const candidate = [state.current, state.previous].find((v) => v && !tried.has(v))
			if (!candidate) break
			tried.add(candidate)
			let verdict = await this.quickCheck(candidate, facts)
			// A read that failed for a moment is tried once more before anything is concluded.
			if (!verdict.ok && verdict.transient) verdict = await this.quickCheck(candidate, facts)
			if (verdict.ok) {
				const updatedAt = candidate === state.current ? state.updatedAt : state.previousUpdatedAt
				const resolved: ResolvedKernel = {
					entry: join(versionFolder(store.paths, candidate), 'dist', 'bin.js'),
					source: 'managed',
					version: candidate,
					engine: verdict.engine,
					...(updatedAt !== undefined ? { updatedAt } : {}),
					...(wentBack.length > 0 ? { wentBack } : {}),
				}
				if (options.hold) resolved.release = this.hold(resolved)
				if (changed || wentBack.length > 0) await this.cleanup()
				return resolved
			}
			wentBack.push({ version: candidate, reason: verdict.reason })
			changed = true
			// A failure to read is not a verdict: the engine stays, and this start goes on without it.
			if (verdict.transient) store.log('quick-check-unreadable', { version: candidate })
			else {
				this.fullyChecked.delete(candidate)
				await store.markBad(candidate, verdict.reason)
			}
		}
		if (changed) await this.cleanup()
		return { ...bundled, ...(wentBack.length > 0 ? { wentBack } : {}) }
	}

	/** Removes what no slot names; never a folder a live host runs from. */
	async cleanup(): Promise<string[]> {
		return this.options.store.cleanup(this.inUse())
	}

	/**
	 * A host was started on `resolved`. Counts the start (the first three decide whether an
	 * engine that dies early is given up) and marks the folder in use until `hostExited`.
	 */
	async hostStarted(resolved: ResolvedKernel): Promise<HostToken> {
		const startedAt = this.options.store.now()
		if (resolved.source !== 'managed' || !resolved.version)
			return { startedAt, startIndex: 0, ended: false }
		const { version } = resolved
		this.live.set(version, (this.live.get(version) ?? 0) + 1)
		let startIndex = 0
		await this.options.store.update((state) => {
			startIndex = (state.starts[version] ?? 0) + 1
			state.starts[version] = startIndex
		})
		return { version, startedAt, startIndex, ended: false }
	}

	/**
	 * A process that is not a host (a terminal tab, a short command) runs from `resolved`: the
	 * folder is kept until the returned function is called. Not counted as a start.
	 */
	hold(resolved: ResolvedKernel): () => void {
		const { version } = resolved
		if (resolved.source !== 'managed' || !version) return () => undefined
		this.live.set(version, (this.live.get(version) ?? 0) + 1)
		let released = false
		return () => {
			if (released) return
			released = true
			const count = (this.live.get(version) ?? 1) - 1
			if (count <= 0) this.live.delete(version)
			else this.live.set(version, count)
		}
	}

	/**
	 * A host ended. `unexpected` is true only when the app did not ask for it (a close the person
	 * made, or the app shutting down, is not a failure of the engine). Returns true when this
	 * exit made the engine be given up.
	 */
	async hostExited(token: HostToken, options: { unexpected: boolean }): Promise<boolean> {
		if (token.ended) return false
		token.ended = true
		const { version } = token
		if (!version) return false
		const count = (this.live.get(version) ?? 1) - 1
		if (count <= 0) this.live.delete(version)
		else this.live.set(version, count)
		const early =
			options.unexpected &&
			this.options.store.now() - token.startedAt < EARLY_EXIT_MS &&
			token.startIndex <= EARLY_EXIT_STARTS
		if (!early) return false
		let giveUp = false
		await this.options.store.update((state) => {
			const next = (state.earlyExits[version] ?? 0) + 1
			state.earlyExits[version] = next
			giveUp = next >= EARLY_EXITS_TO_GIVE_UP
		})
		if (!giveUp) return false
		await this.options.store.markBad(version, 'it ended early twice')
		return true
	}

	/** Marks a managed version bad (it failed to start, to answer, or lacks a required method). */
	markBad(version: string, reason: string): Promise<boolean> {
		return this.options.store.markBad(version, reason)
	}

	/**
	 * "Use this app's own engine": every managed engine is given up, so the next host starts the
	 * bundled one. A newer engine than these can still arrive later.
	 */
	async useOwnEngine(): Promise<void> {
		this.ownChoices++
		const at = this.options.store.now()
		this.options.store.log('own-engine-chosen')
		await this.options.store.update((state: KernelState) => {
			for (const version of [state.current, state.previous, state.pending])
				if (version) markBadIn(state, version, 'the person chose this app’s own engine', at)
		})
		await this.cleanup()
	}
}

export interface HostToken {
	version?: string
	startedAt: number
	startIndex: number
	ended: boolean
}

/**
 * Starts a host, going back when a fetched engine does not work. `attempt` spawns the host and
 * throws when it fails to spawn, to answer `initialize`, or lacks a required method. A failure
 * on a managed engine marks it bad and starts again on whatever resolves next (the one before,
 * then the bundled engine, which always ends the chain); a failure on the bundled engine is the
 * caller's. `isKernelFault` lets the caller say that a failure was not the engine's (a project
 * folder that is gone) and so must not mark anything.
 *
 * The engine of each try is held from the moment it is chosen. On success the hold is handed to
 * the caller as `release`, to be called once the host is registered with `hostStarted`.
 */
export async function startWithFallback<T>(
	manager: KernelManager,
	attempt: (kernel: ResolvedKernel) => Promise<T>,
	options: { isKernelFault?: (error: unknown) => boolean } = {},
): Promise<{ value: T; kernel: ResolvedKernel; retried: boolean; release: () => void }> {
	const wentBack: { version: string; reason: string }[] = []
	let kernel = await manager.resolve({ hold: true })
	for (;;) {
		try {
			const value = await attempt(kernel)
			const gone = [...wentBack, ...(kernel.wentBack ?? [])]
			return {
				value,
				kernel: { ...kernel, ...(gone.length > 0 ? { wentBack: gone } : {}) },
				retried: wentBack.length > 0,
				release: kernel.release ?? (() => undefined),
			}
		} catch (error) {
			kernel.release?.()
			if (kernel.source !== 'managed' || !kernel.version) throw error
			if (options.isKernelFault && !options.isKernelFault(error)) throw error
			const reason = `host failed (${scrub(messageOf(error)).slice(0, 120)})`
			wentBack.unshift({ version: kernel.version, reason })
			await manager.markBad(kernel.version, reason)
			await manager.cleanup().catch(() => undefined)
			kernel = await manager.resolve({ hold: true })
		}
	}
}
