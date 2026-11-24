import { randomInt } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { temporaryPathFor } from '../utils/atomic-write.js'
import { FileLockError, lockPathFor, withFileLockSync } from '../utils/file-lock.js'
import { TeamStoreError } from './types.js'

/**
 * How a team's files are changed by more than one process: a lock file beside the record, bounded
 * retries with a short random wait, and a write that publishes by rename so a reader sees the old file
 * or the new one and never half of one. The retry count is a bound on patience, not a measure of time:
 * a lock whose owner has exited is taken over at once, so waiting is only for an owner that is alive.
 */

/** Tries before a held lock is reported as busy. */
export const LOCK_ATTEMPTS = 100
const WAIT_MIN_MS = 5
const WAIT_MAX_MS = 100

export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** One jittered wait, for callers that sleep without blocking. */
export function jitterDelay(): number {
	return randomInt(WAIT_MIN_MS, WAIT_MAX_MS + 1)
}

export function jitterWait(sleep: (ms: number) => void): (attempt: number) => void {
	return () => sleep(randomInt(WAIT_MIN_MS, WAIT_MAX_MS + 1))
}

/** Run `operation` holding the lock beside `file`; a lock held past the retry bound is a `busy` error. */
export function lockedSync<T>(file: string, sleep: (ms: number) => void, operation: () => T): T {
	try {
		return withFileLockSync(lockPathFor(file), operation, {
			attempts: LOCK_ATTEMPTS,
			wait: jitterWait(sleep),
		})
	} catch (error) {
		if (error instanceof FileLockError)
			throw new TeamStoreError(
				'busy',
				`${file} is in use by another process and did not free up; try again.`,
			)
		throw error
	}
}

const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Tries on transient rename or remove contention (a reader holding the file open on Windows). */
const CONTENTION_ATTEMPTS = 20

/** Remove a file (absent is fine), retrying transient contention like {@link writeAtomicSync}. */
export function removeSync(path: string, sleep: (ms: number) => void = sleepSync): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(path, { force: true })
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? ''
			if (!CONTENDED.has(code) || attempt >= CONTENTION_ATTEMPTS) throw error
			sleep(randomInt(5, 51))
		}
	}
}

/** Publish `content` at `path` by rename, private to the user. Transient Windows contention is retried with a jittered wait. */
export function writeAtomicSync(
	path: string,
	content: string,
	sleep: (ms: number) => void = sleepSync,
): void {
	const temp = temporaryPathFor(path)
	try {
		writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
		for (let attempt = 1; ; attempt++) {
			try {
				renameSync(temp, path)
				return
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? ''
				if (!CONTENDED.has(code) || attempt >= CONTENTION_ATTEMPTS) throw error
				sleep(randomInt(5, 51))
			}
		}
	} catch (error) {
		rmSync(temp, { force: true })
		throw error
	}
}
