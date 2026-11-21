import { join } from 'node:path'
import {
	type FileLockOptions,
	type FileLockSyncOptions,
	runLocked,
	runLockedSync,
} from '../utils/file-lock.js'
import { AccountLockError } from './types.js'

/**
 * The lock file beside a Codex account's `auth.json`. One lock per account
 * directory, so a stuck account never blocks another.
 */
export function codexRefreshLockPath(dir: string): string {
	return join(dir, 'auth.json.namzu.lock')
}

/** The account locks follow the shared lock-file protocol in `utils/file-lock.ts`. */
export type AccountLockOptions = FileLockOptions

export type AccountLockSyncOptions = FileLockSyncOptions

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
export function withAccountLock<T>(
	lockPath: string,
	operation: () => Promise<T> | T,
	options: AccountLockOptions = {},
): Promise<T> {
	return runLocked(lockPath, operation, options, refusal)
}

/** Synchronous form for short store mutations. */
export function withAccountLockSync<T>(
	lockPath: string,
	operation: () => T,
	options: AccountLockSyncOptions = {},
): T {
	return runLockedSync(lockPath, operation, options, refusal)
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
