import { randomBytes } from 'node:crypto'
import {
	type Stats,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isMainThread } from 'node:worker_threads'

/**
 * A lock file beside a shared record, so two processes that read, change and
 * write the same file never lose one another's change.
 *
 * The protocol, which any writer of the same files must follow (Desktop has
 * its own copy because it cannot load this package at run time):
 *
 * - The lock is `<file>.lock`, created with `O_CREAT | O_EXCL` (`'wx'`) and
 *   mode 0600. Its whole body is `<pid>:<epoch ms>:<random hex>`. A creator
 *   whose body write fails removes the lock again before it reports the error.
 * - A lock is stale, and is reclaimed, when its recorded pid no longer exists;
 *   when it records no pid (an empty or cut-off body) and its last change is
 *   more than {@link EMPTY_LOCK_GRACE_MS} away from now, so a creator that
 *   died between creating it and writing its body cannot block the file for
 *   good; or when it records this process's own pid while this process does
 *   not hold it, which is a lock left by an earlier process that had the same
 *   pid. Reclaimers are serialised by `<file>.lock.reclaim` (body: the
 *   reclaimer's pid), and the lock is checked again under that guard, so a
 *   lock that a live owner took in the meantime is never removed. There is no
 *   age timer for a lock with a live owner: a slow owner keeps its lock.
 * - The owner removes the lock when done, and only while the lock still holds
 *   its own body.
 *
 * The lock is held across local read and write work, never across a prompt,
 * and only from a process's main thread.
 */
export class FileLockError extends Error {
	override readonly name: string = 'FileLockError'
	constructor(
		readonly lockPath: string,
		message: string,
	) {
		super(message)
	}
}

export interface FileLockOptions {
	/** How many times to try before refusing. Default 1: a held lock is refused at once. */
	readonly attempts?: number
	/** Waits between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => Promise<void>
}

export interface FileLockSyncOptions {
	/** How many times to try before refusing. Default 1. */
	readonly attempts?: number
	/** Blocks between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => void
}

/**
 * How long a lock that records no owner is left alone. Its creator writes the
 * body right after creating the file, so a lock still without one this long
 * after its last change was left by a creator that failed or was killed.
 */
export const EMPTY_LOCK_GRACE_MS = 10_000

/** The lock file the protocol above uses for `file`. */
export function lockPathFor(file: string): string {
	return `${file}.lock`
}

/**
 * The bodies of the locks this process holds right now, shared by every copy
 * of this module loaded in the same thread, so a lock with this process's pid
 * that none of them holds is known to be left over.
 */
const HELD_KEY = Symbol.for('namzu.file-lock.held')
function heldBodies(): Set<string> {
	const scope = globalThis as { [HELD_KEY]?: Set<string> }
	scope[HELD_KEY] ??= new Set<string>()
	return scope[HELD_KEY]
}

function writeBody(fd: number, body: string): void {
	const bytes = Buffer.from(body, 'utf8')
	let written = 0
	while (written < bytes.length) written += writeSync(fd, bytes, written)
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

function acquire(lockPath: string): string | undefined {
	const token = `${process.pid}:${Date.now()}:${randomBytes(12).toString('hex')}`
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
	for (let pass = 0; pass < 2; pass++) {
		let fd: number
		try {
			fd = openSync(lockPath, 'wx', 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			if (pass === 0 && reclaimIfStale(lockPath)) continue
			return undefined
		}
		try {
			writeBody(fd, token)
		} catch (error) {
			// A full disk creates the file and then fails its body. An empty lock
			// left behind would refuse every later change, so it goes now, while
			// it is still the file this call created.
			try {
				if (sameFile(fstatSync(fd), statSync(lockPath))) rmSync(lockPath, { force: true })
			} catch {
				// Already gone, or replaced by someone else: not ours to remove.
			}
			closeSync(fd)
			throw error
		}
		closeSync(fd)
		heldBodies().add(token)
		return token
	}
	return undefined
}

function pidOf(token: string): number | undefined {
	const pid = Number.parseInt(token.split(':', 1)[0] ?? '', 10)
	return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function processIsDead(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return false
	} catch (error) {
		// EPERM means the process exists but belongs to someone else: alive.
		return (error as NodeJS.ErrnoException).code === 'ESRCH'
	}
}

/** What a lock file says about its owner, read once. */
interface LockSighting {
	readonly body: string
	readonly stat: Stats
}

function sight(lockPath: string): LockSighting | undefined {
	try {
		const stat = statSync(lockPath)
		return { body: readFileSync(lockPath, 'utf8'), stat }
	} catch {
		return undefined
	}
}

function isStale(seen: LockSighting, now: number): boolean {
	const pid = pidOf(seen.body)
	if (pid === undefined) return Math.abs(now - seen.stat.mtimeMs) > EMPTY_LOCK_GRACE_MS
	if (pid === process.pid) return isMainThread && !heldBodies().has(seen.body)
	return processIsDead(pid)
}

/** True when `again` is the very lock `seen` described: same file, same body, unchanged since. */
function unchanged(seen: LockSighting, again: LockSighting): boolean {
	return (
		again.body === seen.body &&
		sameFile(again.stat, seen.stat) &&
		again.stat.mtimeMs === seen.stat.mtimeMs &&
		again.stat.size === seen.stat.size
	)
}

/**
 * Remove a lock that is stale (see the protocol above). Reclaimers are
 * serialised by a guard file, and the lock is re-read under the guard, so a
 * lock that was replaced by a live owner in the meantime is never removed.
 */
function reclaimIfStale(lockPath: string): boolean {
	const seen = sight(lockPath)
	if (seen === undefined) return true // already gone; the caller may simply try again
	if (!isStale(seen, Date.now())) return false
	const guard = `${lockPath}.reclaim`
	let fd: number
	try {
		fd = openSync(guard, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		try {
			const holder = sight(guard)
			if (holder && isStale(holder, Date.now())) rmSync(guard, { force: true })
		} catch {
			// The guard vanished or is unreadable; the next attempt decides.
		}
		return false
	}
	try {
		try {
			writeBody(fd, `${process.pid}`)
		} finally {
			closeSync(fd)
		}
		const again = sight(lockPath)
		if (again === undefined) return true
		if (!unchanged(seen, again)) return false
		rmSync(lockPath, { force: true })
		return true
	} finally {
		rmSync(guard, { force: true })
	}
}

function release(lockPath: string, token: string): void {
	heldBodies().delete(token)
	// Never remove a successor's lock if something else replaced the file.
	try {
		if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true })
	} catch {
		// The work already has its result; a missing lock is not its failure.
	}
}

/** Who holds a lock file, as {@link inspectFileLock} reads it. */
export type FileLockState =
	| { readonly state: 'free' }
	/** `pid` is absent while the lock's creator is still writing its body. */
	| { readonly state: 'held'; readonly pid?: number }
	/** Left by a process that exited (or by an earlier process with this one's pid), or never given an owner. */
	| { readonly state: 'stale'; readonly pid?: number }
	| { readonly state: 'unreadable'; readonly reason: string }

/**
 * Read who holds the lock at `lockPath` without taking or changing it. A stale
 * lock is taken over by the next change that meets it, so this is for saying
 * what is there (as `namzu doctor` does), not for deciding to write.
 */
export function inspectFileLock(lockPath: string, now: number = Date.now()): FileLockState {
	let seen: LockSighting
	try {
		seen = { stat: statSync(lockPath), body: readFileSync(lockPath, 'utf8') }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return { state: 'free' }
		return { state: 'unreadable', reason: code ?? String(error) }
	}
	const pid = pidOf(seen.body)
	if (isStale(seen, now)) return pid === undefined ? { state: 'stale' } : { state: 'stale', pid }
	return pid === undefined ? { state: 'held' } : { state: 'held', pid }
}

function fileLockRefusal(lockPath: string): FileLockError {
	return new FileLockError(
		lockPath,
		`another process holds the lock ${lockPath}. The lock is reclaimed on its own when the process that recorded it has exited; if that process is still running, wait for it to finish.`,
	)
}
/** The shared body of every async lock in this package; `refusal` names the error a caller sees. */
export async function runLocked<T>(
	lockPath: string,
	operation: () => Promise<T> | T,
	options: FileLockOptions,
	refusal: (lockPath: string) => Error,
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? 1)
	let token: string | undefined
	for (let attempt = 0; attempt < attempts; attempt++) {
		token = acquire(lockPath)
		if (token !== undefined) break
		if (attempt + 1 < attempts && options.wait) await options.wait(attempt)
	}
	if (token === undefined) throw refusal(lockPath)
	try {
		return await operation()
	} finally {
		release(lockPath, token)
	}
}

/** The shared body of every sync lock in this package; `refusal` names the error a caller sees. */
export function runLockedSync<T>(
	lockPath: string,
	operation: () => T,
	options: FileLockSyncOptions,
	refusal: (lockPath: string) => Error,
): T {
	const attempts = Math.max(1, options.attempts ?? 1)
	let token: string | undefined
	for (let attempt = 0; attempt < attempts; attempt++) {
		token = acquire(lockPath)
		if (token !== undefined) break
		if (attempt + 1 < attempts && options.wait) options.wait(attempt)
	}
	if (token === undefined) throw refusal(lockPath)
	try {
		return operation()
	} finally {
		release(lockPath, token)
	}
}

/**
 * Run `operation` while holding the lock file at `lockPath` (usually
 * {@link lockPathFor} of the record it guards). A lock whose recorded process
 * has exited is reclaimed; a lock held by a live process is a
 * {@link FileLockError} (or a wait, when attempts and a wait function are given).
 */
export function withFileLock<T>(
	lockPath: string,
	operation: () => Promise<T> | T,
	options: FileLockOptions = {},
): Promise<T> {
	return runLocked(lockPath, operation, options, fileLockRefusal)
}

/** Synchronous form of {@link withFileLock}, for short read-change-write work on a small file. */
export function withFileLockSync<T>(
	lockPath: string,
	operation: () => T,
	options: FileLockSyncOptions = {},
): T {
	return runLockedSync(lockPath, operation, options, fileLockRefusal)
}
