import { join } from 'node:path'
import type { KernelFs } from './fs.js'
import {
	type KernelPaths,
	type KernelState,
	emptyState,
	kernelPaths,
	loadState,
	pairPaths,
	saveState,
	versionFolder,
} from './state.js'
import { isKernelVersion } from './version.js'

/**
 * The managed engines on disk and the state that says which of them count. State is the only
 * authority: a folder the state does not name is leftover and is removed by `cleanup`.
 */

export type KernelLog = (event: string, detail?: Record<string, unknown>) => void

export interface StoreOptions {
	root: string
	fs: KernelFs
	now: () => number
	log?: KernelLog
}

export class KernelStore {
	readonly paths: KernelPaths
	readonly fs: KernelFs
	readonly now: () => number
	readonly log: KernelLog
	private state: KernelState = emptyState()
	/** True when the last attempt to write state failed, so memory is ahead of the disk. */
	private dirty = false
	private chain: Promise<unknown> = Promise.resolve()
	private readonly installing = new Set<string>()

	constructor(options: StoreOptions) {
		this.paths = kernelPaths(options.root)
		this.fs = options.fs
		this.now = options.now
		this.log = options.log ?? (() => undefined)
	}

	/**
	 * Reads state (a missing or damaged file means clean), makes the folders, and empties tmp/:
	 * whatever was being downloaded or unpacked when the app last stopped is not trusted.
	 */
	async open(): Promise<void> {
		this.state = await loadState(this.fs, this.paths)
		this.dirty = false
		try {
			await this.fs.rm(this.paths.tmp)
			await this.fs.mkdir(this.paths.tmp, { recursive: true })
			await this.fs.mkdir(this.paths.versions, { recursive: true })
		} catch (error) {
			this.log('open-failed', { message: messageOf(error) })
		}
	}

	snapshot(): KernelState {
		return structuredClone(this.state)
	}

	/** True when the disk holds exactly what memory holds. */
	get persisted(): boolean {
		return !this.dirty
	}

	/**
	 * Applies a change and writes it. Changes run one at a time, each on the latest state. A
	 * failed write leaves the old file on disk (never a half file), keeps the change in memory
	 * for this run, and returns false.
	 */
	update(change: (state: KernelState) => void): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			const next = structuredClone(this.state)
			change(next)
			this.state = next
			try {
				await saveState(this.fs, this.paths, next)
				this.dirty = false
				return true
			} catch (error) {
				this.dirty = true
				this.log('state-write-failed', { message: messageOf(error) })
				return false
			}
		}
		const result = this.chain.then(run, run)
		this.chain = result
		return result
	}

	/** Marks a version bad for good and drops it from every slot; a bad `current` gives way to `previous`. */
	markBad(version: string, reason: string): Promise<boolean> {
		this.log('marked-bad', { version, reason })
		return this.update((state) => markBadIn(state, version, reason, this.now()))
	}

	/** Versions this store keeps: the three slots. */
	static kept(state: KernelState): Set<string> {
		const kept = new Set<string>()
		for (const version of [state.current, state.previous, state.pending])
			if (version) kept.add(version)
		return kept
	}

	/**
	 * Puts an unpacked folder (from tmp/) into versions/ and the signed pair beside it. A
	 * leftover of the same version that no slot names is replaced.
	 */
	async installFolder(
		version: string,
		unpackedFolder: string,
		pair: { manifest: Uint8Array; signature: Uint8Array },
	): Promise<void> {
		this.installing.add(version)
		const target = versionFolder(this.paths, version)
		const files = pairPaths(this.paths, version)
		await this.fs.mkdir(this.paths.versions, { recursive: true })
		await this.fs.rm(target)
		await this.fs.rename(unpackedFolder, target)
		for (const [path, bytes] of [
			[files.manifest, pair.manifest],
			[files.signature, pair.signature],
		] as const) {
			await this.fs.writeFile(`${path}.tmp`, bytes)
			await this.fs.rename(`${path}.tmp`, path)
		}
	}

	/** Called when an install is over, whatever its end, so cleanup may look at the version again. */
	finishInstall(version: string): void {
		this.installing.delete(version)
	}

	/** Removes a version's folder and pair, if it can. */
	async removeVersion(version: string): Promise<boolean> {
		const files = pairPaths(this.paths, version)
		let ok = true
		for (const path of [versionFolder(this.paths, version), files.manifest, files.signature]) {
			try {
				await this.fs.rm(path)
			} catch (error) {
				ok = false
				this.log('delete-failed', { version, message: messageOf(error) })
			}
		}
		return ok
	}

	/**
	 * Removes everything in versions/ that no slot names and no live host was started from,
	 * bad versions first. A delete that fails is left for the next start. Does nothing while
	 * the disk is behind memory: a slot that is not on disk yet must not be judged by it.
	 */
	async cleanup(inUse: ReadonlySet<string> = new Set()): Promise<string[]> {
		if (this.dirty) return []
		const state = this.state
		const kept = KernelStore.kept(state)
		let names: string[]
		try {
			names = await this.fs.readdir(this.paths.versions)
		} catch {
			return []
		}
		const doomed: { name: string; version: string | undefined }[] = []
		for (const name of names) {
			const version = versionOfEntry(name)
			if (version && (this.installing.has(version) || inUse.has(version))) continue
			if (version && !name.endsWith('.tmp') && kept.has(version)) continue
			doomed.push({ name, version })
		}
		doomed.sort((a, b) => Number(isBad(state, b.version)) - Number(isBad(state, a.version)))
		const removed: string[] = []
		for (const { name } of doomed) {
			try {
				await this.fs.rm(join(this.paths.versions, name))
				removed.push(name)
			} catch (error) {
				this.log('delete-failed', { name, message: messageOf(error) })
			}
		}
		return removed
	}
}

function isBad(state: KernelState, version: string | undefined): boolean {
	return version !== undefined && state.bad[version] !== undefined
}

/** The version a name in versions/ belongs to: the folder, its pair, or the pair's temp file. */
export function versionOfEntry(name: string): string | undefined {
	for (const suffix of [
		'.manifest.json.sig.tmp',
		'.manifest.json.tmp',
		'.manifest.json.sig',
		'.manifest.json',
	]) {
		if (name.endsWith(suffix)) {
			const head = name.slice(0, -suffix.length)
			return isKernelVersion(head) ? head : undefined
		}
	}
	return isKernelVersion(name) ? name : undefined
}

export function markBadIn(state: KernelState, version: string, reason: string, at: number): void {
	state.bad[version] = { reason: reason.slice(0, 300), at }
	if (state.pending === version) state.pending = undefined
	if (state.previous === version) {
		state.previous = undefined
		state.previousUpdatedAt = undefined
	}
	if (state.current === version) {
		state.current = state.previous
		state.updatedAt = state.previousUpdatedAt
		state.previous = undefined
		state.previousUpdatedAt = undefined
	}
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
