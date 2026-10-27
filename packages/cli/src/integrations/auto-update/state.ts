/**
 * What the updater keeps on disk, under `<Namzu home>/updates/`:
 *
 * - `update.lock`   one process updating at a time
 * - `check.json`    when any Namzu process last looked, so two terminals do not both ask
 * - `last-result.json`  the outcome of the last automatic attempt
 * - `previous/<version>/`  the copy of the package an update replaced
 *
 * Every write goes through a temporary file and a rename. A damaged file reads
 * as absent: the worst outcome is one extra look at the registry.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export function updatesDir(home: string): string {
	return join(home, 'updates')
}

function writeJsonAtomic(path: string, value: unknown, pid: number): void {
	mkdirSync(join(path, '..'), { recursive: true })
	const temp = `${path}.${pid}.tmp`
	writeFileSync(temp, `${JSON.stringify(value)}\n`)
	renameSync(temp, path)
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------- throttle

export interface CheckRecord {
	readonly at: number
	readonly channel: string
	readonly version: string
	readonly integrity?: string
}

export function readCheck(home: string): CheckRecord | undefined {
	const value = readJson(join(updatesDir(home), 'check.json')) as Partial<CheckRecord> | undefined
	if (
		!value ||
		typeof value.at !== 'number' ||
		typeof value.channel !== 'string' ||
		typeof value.version !== 'string'
	) {
		return undefined
	}
	return value as CheckRecord
}

export function writeCheck(home: string, record: CheckRecord, pid = process.pid): void {
	try {
		writeJsonAtomic(join(updatesDir(home), 'check.json'), record, pid)
	} catch {
		// Not being able to remember a look only means one more look.
	}
}

// ------------------------------------------------------------ last result

export type UpdateOutcome = 'installed' | 'failed' | 'skipped'

export interface UpdateResult {
	readonly at: string
	readonly outcome: UpdateOutcome
	/** A short code: `no_permission`, `in_use`, `verify_failed`, `network`, `install_failed`, `restored`, … */
	readonly status: string
	readonly method: string
	readonly from: string
	readonly to: string
	/** Plain-words reason, kept for `namzu upgrade --check`. */
	readonly detail?: string
}

export function readLastResult(home: string): UpdateResult | undefined {
	const value = readJson(join(updatesDir(home), 'last-result.json')) as
		| Partial<UpdateResult>
		| undefined
	if (!value || typeof value.at !== 'string' || typeof value.outcome !== 'string') return undefined
	return value as UpdateResult
}

export function writeLastResult(home: string, result: UpdateResult, pid = process.pid): void {
	try {
		writeJsonAtomic(join(updatesDir(home), 'last-result.json'), result, pid)
	} catch {
		// The record is a convenience; the update outcome does not depend on it.
	}
}

// ------------------------------------------------------------------- lock

export interface UpdateLock {
	release(): void
}

export interface AcquireLockOptions {
	readonly home: string
	readonly pid?: number
	readonly now?: () => number
	/** Whether a process id still names a running process. */
	readonly isAlive?: (pid: number) => boolean
	/** A lock older than this is taken over even when its pid is alive. Default fifteen minutes, longer than the slowest single update (install, start check and restore). */
	readonly staleMs?: number
}

export const LOCK_STALE_MS = 15 * 60_000

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** The update lock, or `null` when another live process holds it. Throws when the state folder cannot be made. */
export function acquireUpdateLock(options: AcquireLockOptions): UpdateLock | null {
	const pid = options.pid ?? process.pid
	const now = options.now ?? Date.now
	const isAlive = options.isAlive ?? processIsAlive
	const staleMs = options.staleMs ?? LOCK_STALE_MS
	const dir = updatesDir(options.home)
	const path = join(dir, 'update.lock')
	// Throws when the folder cannot exist: that is a broken home, not another process.
	mkdirSync(dir, { recursive: true })
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(path, 'wx')
			try {
				writeFileSync(fd, JSON.stringify({ pid, at: now() }))
			} finally {
				closeSync(fd)
			}
			return {
				release() {
					const held = readJson(path) as { pid?: unknown } | undefined
					if (held?.pid === pid) rmSync(path, { force: true })
				},
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		const held = readJson(path) as { pid?: unknown; at?: unknown } | undefined
		const heldPid = typeof held?.pid === 'number' ? held.pid : undefined
		const heldAt = typeof held?.at === 'number' ? held.at : undefined
		const stale =
			heldPid === undefined || heldAt === undefined || !isAlive(heldPid) || now() - heldAt > staleMs
		if (!stale) return null
		rmSync(path, { force: true })
	}
	return null
}

// ------------------------------------------------------- in-progress marker

/** Written before an update touches the package folder, removed once it is verified or put back. */
export interface InProgressMarker {
	readonly pid: number
	/** The version being installed. */
	readonly to: string
	/** The version being replaced. */
	readonly from: string
	/** The kept copy of the replaced package (npm installs); absent for pnpm. */
	readonly backup?: string
	readonly at: number
}

export function writeInProgress(home: string, marker: InProgressMarker): void {
	writeJsonAtomic(join(updatesDir(home), 'in-progress.json'), marker, marker.pid)
}

export function readInProgress(home: string): InProgressMarker | undefined {
	const value = readJson(join(updatesDir(home), 'in-progress.json')) as
		| Partial<InProgressMarker>
		| undefined
	if (
		!value ||
		typeof value.pid !== 'number' ||
		typeof value.to !== 'string' ||
		typeof value.from !== 'string'
	) {
		return undefined
	}
	return value as InProgressMarker
}

export function clearInProgress(home: string): void {
	rmSync(join(updatesDir(home), 'in-progress.json'), { force: true })
}

export function processIsRunning(pid: number): boolean {
	return processIsAlive(pid)
}

// --------------------------------------------------------------- previous

/** Where the copy of a replaced package is kept. */
export function previousDir(home: string, version: string): string {
	return join(updatesDir(home), 'previous', version)
}

/** Keep the newest `keep` previous copies and delete the rest. */
export function pruneOlderPrevious(home: string, keep = 2): void {
	const root = join(updatesDir(home), 'previous')
	try {
		if (!existsSync(root)) return
		const entries = readdirSync(root)
			.map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)
		for (const entry of entries.slice(keep))
			rmSync(join(root, entry.name), { recursive: true, force: true })
	} catch {
		// Housekeeping only.
	}
}
