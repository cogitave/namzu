/**
 * Watching the files hooks asked about, and nothing else.
 *
 * A `file_changed` hook names the files it cares about in its matcher
 * (`.envrc|package.json`), and may hand back more (`watchPaths`). This file
 * turns those paths into events. No watcher exists until a path is given, and
 * `setPaths([])` closes them all.
 *
 * ## How
 *
 * The platform's own `fs.watch`, on the folder that holds each file rather
 * than on the file: an editor that saves by writing a new file and renaming
 * it over the old one would leave a watch on the file pointing at a file that
 * is gone, and a watch on a folder also sees a file appear and disappear.
 * One watch serves every file in a folder.
 *
 * ## Settling
 *
 * What the platform reports is noisy: an editor's save is several events, and
 * the names differ between systems. Every event for a watched file only
 * restarts a timer; when the file has been still for `settleMs` (half a
 * second) the file is looked at once, and the event is `add` (it did not exist
 * and does now), `unlink` (it did and does not) or `change` (it exists, and
 * did). A file that did not exist before and does not now is no event.
 *
 * ## Limits
 *
 * At most {@link MAX_WATCHED_PATHS} files are watched. A longer list is cut
 * (the first ones are kept, in the order given) and the cut is reported once.
 * A watch that cannot be started or breaks (the folder does not exist, no
 * permission, the system's watch limit) is reported once for that folder and
 * the others carry on; the watch is not retried until the list is set again.
 * Watches never keep the process alive.
 */

import { type FSWatcher, statSync, watch } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import type { PluginFileChange } from '../types/plugin/index.js'

/** The most files watched at once, matcher paths and handed-back paths together. */
export const MAX_WATCHED_PATHS = 64
/** How long a file must be still before its change is reported, in milliseconds. */
export const FILE_SETTLE_MS = 500

export interface FileChange {
	readonly path: string
	readonly change: PluginFileChange
}

/** The platform's folder watch, as far as this file uses it. */
export type WatchDirectory = (
	directory: string,
	listener: (name: string | null) => void,
	onError: (error: Error) => void,
) => { close(): void }

export interface FileChangeWatcherOptions {
	readonly onChange: (change: FileChange) => void
	/** Called once for each distinct problem, in a sentence. */
	readonly onProblem?: (message: string) => void
	readonly settleMs?: number
	readonly maxPaths?: number
	/** A seam for tests; default `fs.watch`, not persistent. */
	readonly watchDirectory?: WatchDirectory
	/** A seam for tests; default a `stat`. */
	readonly exists?: (path: string) => boolean
}

const defaultWatchDirectory: WatchDirectory = (directory, listener, onError) => {
	const watcher: FSWatcher = watch(directory, { persistent: false }, (_type, name) => {
		listener(name === null || name === undefined ? null : String(name))
	})
	watcher.on('error', onError)
	return watcher
}

const defaultExists = (path: string): boolean => {
	try {
		statSync(path)
		return true
	} catch {
		return false
	}
}

/** The case-insensitive file systems compare names without regard to case. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin'
const fold = (name: string): string => (FOLDS_CASE ? name.toLowerCase() : name)

interface Watched {
	existed: boolean
	timer: ReturnType<typeof setTimeout> | undefined
}

export class FileChangeWatcher {
	private readonly files = new Map<string, Watched>()
	private readonly folders = new Map<string, { close(): void }>()
	private readonly failed = new Set<string>()
	private readonly reported = new Set<string>()
	private closed = false

	constructor(private readonly options: FileChangeWatcherOptions) {}

	/** The files watched now, absolute. */
	get watching(): readonly string[] {
		return [...this.files.keys()]
	}

	/**
	 * Watch exactly these files from now on. A relative path is under `base`.
	 * A file already watched keeps its state; one no longer named is let go.
	 */
	setPaths(paths: readonly string[], base: string): void {
		if (this.closed) return
		const limit = this.options.maxPaths ?? MAX_WATCHED_PATHS
		const wanted: string[] = []
		for (const path of paths) {
			const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
			if (!wanted.includes(absolute)) wanted.push(absolute)
		}
		if (wanted.length > limit) {
			this.report(
				`Hooks asked to watch ${wanted.length} files; only the first ${limit} are watched.`,
			)
			wanted.length = limit
		}
		const exists = this.options.exists ?? defaultExists
		for (const [path, state] of this.files) {
			if (wanted.includes(path)) continue
			if (state.timer !== undefined) clearTimeout(state.timer)
			this.files.delete(path)
		}
		for (const path of wanted) {
			if (!this.files.has(path)) this.files.set(path, { existed: exists(path), timer: undefined })
		}
		const folders = new Set(wanted.map((path) => dirname(path)))
		for (const [folder, handle] of this.folders) {
			if (folders.has(folder)) continue
			handle.close()
			this.folders.delete(folder)
		}
		this.failed.clear()
		for (const folder of folders) {
			if (!this.folders.has(folder)) this.start(folder)
		}
	}

	close(): void {
		this.closed = true
		for (const state of this.files.values()) {
			if (state.timer !== undefined) clearTimeout(state.timer)
		}
		this.files.clear()
		for (const handle of this.folders.values()) handle.close()
		this.folders.clear()
	}

	private report(message: string): void {
		if (this.reported.has(message)) return
		this.reported.add(message)
		this.options.onProblem?.(message)
	}

	private start(folder: string): void {
		const watchDirectory = this.options.watchDirectory ?? defaultWatchDirectory
		try {
			const handle = watchDirectory(
				folder,
				(name) => this.touched(folder, name),
				(error) => {
					this.drop(folder)
					this.report(`Watching files in ${folder} stopped: ${error.message}.`)
				},
			)
			this.folders.set(folder, handle)
		} catch (error) {
			this.failed.add(folder)
			this.report(
				`Files in ${folder} cannot be watched (${error instanceof Error ? error.message : String(error)}).`,
			)
		}
	}

	private drop(folder: string): void {
		const handle = this.folders.get(folder)
		this.folders.delete(folder)
		try {
			handle?.close()
		} catch {
			// Already closed by the error that brought us here.
		}
		this.failed.add(folder)
	}

	/** An event in `folder`: for one name, or for every file in it when the system gave no name. */
	private touched(folder: string, name: string | null): void {
		if (this.closed) return
		for (const path of this.files.keys()) {
			if (dirname(path) !== folder) continue
			if (name !== null && fold(basename(path)) !== fold(name)) continue
			this.schedule(path)
		}
	}

	private schedule(path: string): void {
		const state = this.files.get(path)
		if (state === undefined) return
		if (state.timer !== undefined) clearTimeout(state.timer)
		const timer = setTimeout(() => this.settle(path), this.options.settleMs ?? FILE_SETTLE_MS)
		timer.unref?.()
		state.timer = timer
	}

	private settle(path: string): void {
		const state = this.files.get(path)
		if (state === undefined || this.closed) return
		state.timer = undefined
		const exists = (this.options.exists ?? defaultExists)(path)
		const before = state.existed
		state.existed = exists
		const change: PluginFileChange | undefined =
			before && exists
				? 'change'
				: !before && exists
					? 'add'
					: before && !exists
						? 'unlink'
						: undefined
		if (change !== undefined) this.options.onChange({ path, change })
	}
}
