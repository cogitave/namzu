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
	let fd: number
	try {
		fd = openSync(lockPath, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
		throw error
	}
	try {
		writeSync(fd, token)
	} finally {
		closeSync(fd)
	}
	return token
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
		`another owner holds the account lock ${lockPath}. A lock left by a dead process is not reclaimed automatically; after proving no Namzu process is using this account, remove the file and retry.`,
	)
}

/**
 * Run `operation` while holding the lock file at `lockPath`. The lock is held
 * across local read/write work, never across a user prompt. A present lock is a
 * refusal, not something to steal: a path-based staleness check cannot prove it
 * is unlinking the inode it inspected.
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

/** Synchronous form for short store mutations. A held lock is refused at once. */
export function withAccountLockSync<T>(lockPath: string, operation: () => T): T {
	const token = acquire(lockPath)
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
