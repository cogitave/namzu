/**
 * What the updater keeps on disk, under `<Namzu home>/updates/`:
 *
 * - `locks/<install>/`  one process updating each install at a time
 * - `check.json`    when any Namzu process last looked, so two terminals do not both ask
 * - `last-result-<install>.json`  the outcome of the last automatic attempt on one install
 * - `attempt-<install>.json`  the version the last failed attempt on one install was for, so it is not tried again
 * - `previous/<install>/<version>/`  the copy of the package an update replaced
 * - `in-progress-<install>.json`  an update that has touched the package and is not yet verified
 *
 * Every write goes through a temporary file and a rename. A damaged file reads
 * as absent: the worst outcome is one extra look at the registry.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, posix, win32 } from 'node:path'

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
	readonly tarball?: string
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
	/** The installer's output for that attempt, for the person who wants the details. */
	readonly log?: string
}

export function readLastResult(home: string, scope: string): UpdateResult | undefined {
	const value = readJson(join(updatesDir(home), `last-result-${scope}.json`)) as
		| Partial<UpdateResult>
		| undefined
	if (!value || typeof value.at !== 'string' || typeof value.outcome !== 'string') return undefined
	return value as UpdateResult
}

export function writeLastResult(
	home: string,
	scope: string,
	result: UpdateResult,
	pid = process.pid,
): void {
	try {
		writeJsonAtomic(join(updatesDir(home), `last-result-${scope}.json`), result, pid)
	} catch {
		// The record is a convenience; the update outcome does not depend on it.
	}
}

// ---------------------------------------------------------- failed attempt

/**
 * The version an automatic install gave up on, so the next start does not swap
 * the package folder for it all over again under windows that are still open.
 */
export interface AttemptRecord {
	readonly version: string
	/** Why it failed (a `FailureStatus`). */
	readonly code: string
	readonly at: number
	/** The person has been told about this version. */
	readonly shown: boolean
}

export function readAttempt(home: string, scope: string): AttemptRecord | undefined {
	const value = readJson(join(updatesDir(home), `attempt-${scope}.json`)) as
		| Partial<AttemptRecord>
		| undefined
	if (
		!value ||
		typeof value.version !== 'string' ||
		typeof value.code !== 'string' ||
		typeof value.at !== 'number' ||
		typeof value.shown !== 'boolean'
	) {
		return undefined
	}
	return value as AttemptRecord
}

export function writeAttempt(
	home: string,
	scope: string,
	record: AttemptRecord,
	pid = process.pid,
): void {
	try {
		writeJsonAtomic(join(updatesDir(home), `attempt-${scope}.json`), record, pid)
	} catch {
		// Not remembering costs one more attempt at the next start, never a wrong install.
	}
}

// ------------------------------------------------------------------- lock

/**
 * The folder a lock, an in-progress marker and the kept copies belong to. Two
 * installs (two prefixes, a global npm and a global pnpm folder) never wait on
 * one another, and one install is only ever changed by one process.
 */
export function installScope(
	location: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const resolved = (platform === 'win32' ? win32 : posix).resolve(location)
	const comparable = platform === 'win32' ? resolved.toLowerCase() : resolved
	return createHash('sha256').update(comparable).digest('hex').slice(0, 12)
}

export interface UpdateLock {
	release(): void
}

export interface AcquireLockOptions {
	readonly home: string
	/** The install the lock is for ({@link installScope}). */
	readonly scope?: string
	readonly pid?: number
	readonly now?: () => number
	/** Whether a process id still names a running process. */
	readonly isAlive?: (pid: number) => boolean
	/** A lock older than this is taken over even when its pid is alive. Default fifteen minutes, longer than the slowest single update (install, start check and restore). */
	readonly staleMs?: number
}

export const LOCK_STALE_MS = 15 * 60_000

interface LockBody {
	readonly pid: number
	readonly at: number
	readonly nonce: string
	readonly released?: boolean
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

function lockDir(home: string, scope: string | undefined): string {
	return join(updatesDir(home), 'locks', scope ?? 'shared')
}

function generations(dir: string): number[] {
	try {
		return readdirSync(dir)
			.filter((name) => /^\d+$/.test(name))
			.map(Number)
			.sort((a, b) => a - b)
	} catch {
		return []
	}
}

/**
 * Create `path` holding `body`, failing with EEXIST when it exists. The content is
 * written to a private file and linked into place, so no other process ever sees
 * the lock empty or half written.
 */
function createExclusive(path: string, body: string): void {
	const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	writeFileSync(temp, body)
	try {
		linkSync(temp, path)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'EEXIST') throw error
		// A file system without hard links: create it in place instead.
		const fd = openSync(path, 'wx')
		try {
			writeFileSync(fd, body)
		} finally {
			closeSync(fd)
		}
	} finally {
		rmSync(temp, { force: true })
	}
}

/**
 * The update lock for one install, or `null` when another live process holds it.
 * Throws when the state folder cannot be made.
 *
 * The lock is a numbered file: whoever creates the next number holds the lock,
 * and the highest number is always the current holder. Creating a number that
 * exists fails, so when two processes both find the same stale holder and both
 * try to take over, exactly one of them creates the next number and the other
 * sees a live lock. Numbers only grow (a released lock stays as the highest one,
 * marked released), so a late process can never create a number that was
 * already used.
 */
export function acquireUpdateLock(options: AcquireLockOptions): UpdateLock | null {
	const pid = options.pid ?? process.pid
	const now = options.now ?? Date.now
	const isAlive = options.isAlive ?? processIsAlive
	const staleMs = options.staleMs ?? LOCK_STALE_MS
	const dir = lockDir(options.home, options.scope)
	// Throws when the folder cannot exist: that is a broken home, not another process.
	mkdirSync(dir, { recursive: true })
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const all = generations(dir)
		const top = all.length > 0 ? (all[all.length - 1] as number) : 0
		if (top > 0) {
			const held = readJson(join(dir, String(top))) as Partial<LockBody> | undefined
			const live =
				held !== undefined &&
				held.released !== true &&
				typeof held.pid === 'number' &&
				typeof held.at === 'number' &&
				isAlive(held.pid) &&
				now() - held.at <= staleMs
			if (live) return null
		}
		const next = top + 1
		const nonce = randomBytes(8).toString('hex')
		const path = join(dir, String(next))
		try {
			createExclusive(path, JSON.stringify({ pid, at: now(), nonce } satisfies LockBody))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
			throw error
		}
		for (const old of all) rmSync(join(dir, String(old)), { force: true })
		return {
			release() {
				const held = readJson(path) as Partial<LockBody> | undefined
				if (held?.nonce !== nonce) return
				try {
					writeJsonAtomic(path, { pid, at: now(), nonce, released: true } satisfies LockBody, pid)
				} catch {
					// A lock that cannot be marked released times out like any other.
				}
			},
		}
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
	/** The package manager's process, once started; it can outlive `pid`. */
	readonly installerPid?: number
	readonly at: number
}

function markerPath(home: string, scope: string | undefined): string {
	return join(updatesDir(home), scope ? `in-progress-${scope}.json` : 'in-progress.json')
}

export function writeInProgress(home: string, marker: InProgressMarker, scope?: string): void {
	writeJsonAtomic(markerPath(home, scope), marker, marker.pid)
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/

export function readInProgress(home: string, scope?: string): InProgressMarker | undefined {
	const value = readJson(markerPath(home, scope)) as Partial<InProgressMarker> | undefined
	if (
		!value ||
		typeof value.pid !== 'number' ||
		typeof value.to !== 'string' ||
		typeof value.from !== 'string' ||
		typeof value.at !== 'number' ||
		!VERSION_SHAPE.test(value.from) ||
		!VERSION_SHAPE.test(value.to)
	) {
		return undefined
	}
	return value as InProgressMarker
}

export function clearInProgress(home: string, scope?: string): void {
	rmSync(markerPath(home, scope), { force: true })
}

export function processIsRunning(pid: number): boolean {
	return processIsAlive(pid)
}

// --------------------------------------------------------------- previous

/** Where the copy of a replaced package is kept. */
export function previousDir(home: string, version: string, scope?: string): string {
	return scope
		? join(updatesDir(home), 'previous', scope, version)
		: join(updatesDir(home), 'previous', version)
}

/** Keep the newest `keep` previous copies and delete the rest. */
export function pruneOlderPrevious(home: string, keep = 2, scope?: string): void {
	const root = scope
		? join(updatesDir(home), 'previous', scope)
		: join(updatesDir(home), 'previous')
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
