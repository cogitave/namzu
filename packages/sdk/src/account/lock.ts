import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { AccountLockError } from './types.js'

/**
 * The lock file beside a Codex account's `auth.json`. One lock per account
 * directory, so a stuck account never blocks another.
 */
export function codexRefreshLockPath(dir: string): string {
	return `${dir}/auth.json.namzu.lock`
}

export interface AccountLockOptions {
	/** How many times to try before refusing. Default 1: a held lock is refused at once. */
	readonly attempts?: number
	/** Waits between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => Promise<void>
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
			writeSync(fd, token)
		} finally {
			closeSync(fd)
		}
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

/**
 * Remove a lock whose recorded owner process no longer exists. Reclaimers are
 * serialised by a guard file, and the lock is re-read under the guard, so a
 * lock that was replaced by a live owner in the meantime is never removed.
 */
function reclaimIfStale(lockPath: string): boolean {
	let observed: string
	try {
		observed = readFileSync(lockPath, 'utf8')
	} catch {
		return true // already gone; the caller may simply try again
	}
	const pid = pidOf(observed)
	if (pid === undefined || !processIsDead(pid)) return false
	const guard = `${lockPath}.reclaim`
	let fd: number
	try {
		fd = openSync(guard, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		try {
			const holder = pidOf(readFileSync(guard, 'utf8'))
			if (holder !== undefined && processIsDead(holder)) rmSync(guard, { force: true })
		} catch {
			// The guard vanished or is unreadable; the next attempt decides.
		}
		return false
	}
	try {
		writeSync(fd, `${process.pid}`)
		closeSync(fd)
		let again: string | undefined
		try {
			again = readFileSync(lockPath, 'utf8')
		} catch {
			return true
		}
		if (again !== observed) return false
		rmSync(lockPath, { force: true })
		return true
	} finally {
		rmSync(guard, { force: true })
	}
}

function release(lockPath: string, token: string): void {
	// Never remove a successor's lock if something else replaced the file.
	try {
		if (readFileSync(lockPath, 'utf8') === token) rmSync(lockPath, { force: true })
	} catch {
		// The work already has its result; a missing lock is not its failure.
	}
}

function refusal(lockPath: string): AccountLockError {
	return new AccountLockError(
		lockPath,
		`another owner holds the account lock ${lockPath}. The lock is reclaimed on its own when the process that recorded it has exited; if that process is still running, wait for it to finish.`,
	)
}

/**
 * Run `operation` while holding the lock file at `lockPath`. The lock is held
 * across local read/write work, never across a user prompt. A lock whose
 * recorded process has exited is reclaimed; a lock held by a live process is a
 * refusal (or a wait, when attempts and a wait function are given).
 */
export async function withAccountLock<T>(
	lockPath: string,
	operation: () => Promise<T> | T,
	options: AccountLockOptions = {},
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

export interface AccountLockSyncOptions {
	/** How many times to try before refusing. Default 1. */
	readonly attempts?: number
	/** Blocks between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => void
}

/** Synchronous form for short store mutations. */
export function withAccountLockSync<T>(
	lockPath: string,
	operation: () => T,
	options: AccountLockSyncOptions = {},
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
 * Serialise a Codex account's read-refresh-write. A reader that implements
 * `AccountCredentialReaders.codexHome` takes this around the whole cycle and
 * compares the file's tokens with what it read before writing back.
 */
export function withAccountRefreshLock<T>(
	dir: string,
	operation: () => Promise<T> | T,
	options: AccountLockOptions = {},
): Promise<T> {
	return withAccountLock(codexRefreshLockPath(dir), operation, options)
}
