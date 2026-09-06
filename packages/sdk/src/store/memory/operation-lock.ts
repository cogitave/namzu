import { randomUUID } from 'node:crypto'
import { type FileHandle, lstat, open, readFile, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { NamzuError } from '../../types/errors/index.js'

/** Wait bound, not a lease: a slow or crashed owner is never silently replaced. */
export const DEFAULT_MEMORY_LOCK_TIMEOUT_MS = 10_000

export function validateMemoryLockTimeout(timeoutMs: number): void {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: 'DiskMemoryStore lockTimeoutMs must be a positive safe integer.',
			retryable: false,
		})
	}
}

function lockError(path: string, reason: string, timeoutMs: number): NamzuError {
	return new NamzuError({
		code: 'storage_error',
		message: `Memory operation lock ${path}: ${reason}. Stop all processes using this memory store and inspect the lock owner before removing a stale lock; it is never broken automatically.`,
		details: { lockPath: path, timeoutMs },
		retryable: false,
	})
}

/**
 * Local-filesystem exclusion for cooperating processes. Atomic rename of the
 * index alone cannot serialize the index/content read-modify-write transaction.
 * An abandoned lock fails closed; guessing a lease expired would permit two
 * live writers to overwrite each other again.
 */
export async function acquireMemoryOperationLock(
	path: string,
	timeoutMs: number,
): Promise<() => Promise<void>> {
	const deadline = performance.now() + timeoutMs
	let attempted = false
	for (;;) {
		if (attempted && performance.now() >= deadline) {
			throw lockError(path, `acquisition timed out after ${timeoutMs} ms`, timeoutMs)
		}
		attempted = true
		let handle: FileHandle
		try {
			handle = await open(path, 'wx', 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			const existing = await lstat(path).catch((statError: NodeJS.ErrnoException) => {
				if (statError.code === 'ENOENT') return undefined
				throw statError
			})
			if (!existing) continue
			if (!existing.isFile() || existing.isSymbolicLink()) {
				throw lockError(path, 'the occupied lock is not a regular file', timeoutMs)
			}
			if (performance.now() >= deadline) {
				throw lockError(path, `acquisition timed out after ${timeoutMs} ms`, timeoutMs)
			}
			await delay(Math.min(25, Math.max(1, deadline - performance.now())))
			continue
		}

		const owner = `${JSON.stringify({ pid: process.pid, token: randomUUID(), acquiredAt: Date.now() })}\n`
		const identity = await handle.stat().catch(async (error: unknown) => {
			await handle.close()
			// Exclusive create happened, but ownership could not be established.
			// Leave the path for explicit recovery rather than unlink an unknown inode.
			throw error
		})
		try {
			await handle.writeFile(owner, 'utf8')
			await handle.sync()
		} catch (error) {
			await handle.close()
			const current = await lstat(path).catch(() => undefined)
			if (current?.dev === identity.dev && current.ino === identity.ino) {
				await unlink(path).catch(() => undefined)
			}
			throw error
		}
		await handle.close()
		return async () => {
			const current = await lstat(path)
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.dev !== identity.dev ||
				current.ino !== identity.ino ||
				(await readFile(path, 'utf8')) !== owner
			) {
				throw lockError(path, 'the lock owner changed before release', timeoutMs)
			}
			await unlink(path)
		}
	}
}
