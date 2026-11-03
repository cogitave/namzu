import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { NamzuError } from '../../types/errors/index.js'
import type { Logger } from '../../utils/logger.js'

/** Wait bound, not a lease: a slow owner that is still running is never replaced. */
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

/**
 * An empty or unparsable lock file is only believed abandoned once it is older
 * than this. A live acquirer writes its record immediately after creating the
 * file, so a gap of seconds means the writer died in between (disk full, kill).
 */
export const MEMORY_LOCK_RECORD_GRACE_MS = 5_000

export interface MemoryOperationLockOptions {
	readonly logger?: Logger
	/** Clock compared against file mtimes. */
	readonly now?: () => number
	/** True when a process with this pid exists on this machine. */
	readonly isPidAlive?: (pid: number) => boolean
	readonly hostname?: string
}

interface OwnerRecord {
	readonly pid: number
	readonly token: string
	readonly acquiredAt: number
	readonly hostname?: string
}

interface Inspection {
	readonly stats: Stats
	readonly content: string
	readonly pid: number | undefined
	/** Set only when the owner is provably gone. */
	readonly staleReason: string | undefined
}

interface Resolved {
	readonly logger: Logger | undefined
	readonly now: () => number
	readonly isPidAlive: (pid: number) => boolean
	readonly hostname: string
}

/**
 * Residual risk, deliberately accepted: a pid that is alive is treated as the
 * owner even when it is an unrelated process that reused the number after the
 * real owner died. That cannot be disproved from here, so such a lock stays and
 * the caller gets the plain "another process is using it" error. It is not
 * bounded by `acquiredAt` age: a lock's age is not a lease.
 */
function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

function lockError(path: string, message: string, timeoutMs: number): NamzuError {
	return new NamzuError({
		code: 'storage_error',
		message,
		details: { lockPath: path, timeoutMs },
		retryable: false,
	})
}

function busyError(path: string, pid: number | undefined, timeoutMs: number): NamzuError {
	const who =
		pid === undefined ? 'Another Namzu process is' : `Another Namzu process (pid ${pid}) is`
	return lockError(
		path,
		`${who} using the stored memory. Close it, or wait for it to finish.`,
		timeoutMs,
	)
}

function parseOwner(content: string): OwnerRecord | undefined {
	try {
		const value: unknown = JSON.parse(content)
		if (!value || typeof value !== 'object') return undefined
		const pid = (value as { pid?: unknown }).pid
		if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
		const host = (value as { hostname?: unknown }).hostname
		return {
			pid,
			token: String((value as { token?: unknown }).token ?? ''),
			acquiredAt: Number((value as { acquiredAt?: unknown }).acquiredAt ?? 0),
			...(typeof host === 'string' && host.length > 0 ? { hostname: host } : {}),
		}
	} catch {
		return undefined
	}
}

/** Reads the file at `path`; undefined when it is gone or was swapped while reading. */
async function inspect(path: string, env: Resolved): Promise<Inspection | undefined> {
	const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined
		throw error
	})
	if (!before) return undefined
	if (!before.isFile() || before.isSymbolicLink())
		return { stats: before, content: '', pid: undefined, staleReason: undefined }
	const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined
		throw error
	})
	if (content === undefined) return undefined
	const after = await lstat(path).catch(() => undefined)
	if (!after || after.dev !== before.dev || after.ino !== before.ino) return undefined

	const owner = parseOwner(content)
	if (owner) {
		// A record from another host on a shared filesystem cannot be checked from
		// here; it is live. A record without a host predates the field: local.
		if (owner.hostname !== undefined && owner.hostname !== env.hostname) {
			return { stats: before, content, pid: owner.pid, staleReason: undefined }
		}
		return {
			stats: before,
			content,
			pid: owner.pid,
			staleReason: env.isPidAlive(owner.pid) ? undefined : `owner process ${owner.pid} is gone`,
		}
	}
	const age = env.now() - before.mtimeMs
	return {
		stats: before,
		content,
		pid: undefined,
		staleReason:
			age > MEMORY_LOCK_RECORD_GRACE_MS
				? `lock holds no readable owner record and is ${Math.round(age / 1000)}s old`
				: undefined,
	}
}

/**
 * Creates `path` exclusively and writes this process's owner record. Returns
 * undefined when the path is occupied. A failed write (a full disk) leaves no
 * file behind.
 */
async function createOwned(
	path: string,
	env: Resolved,
): Promise<{ identity: Stats; owner: string } | undefined> {
	let handle: Awaited<ReturnType<typeof open>>
	try {
		handle = await open(path, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
		throw error
	}
	const owner = `${JSON.stringify({
		pid: process.pid,
		token: randomUUID(),
		acquiredAt: Date.now(),
		hostname: env.hostname,
	})}\n`
	let identity: Stats | undefined
	try {
		identity = await handle.stat()
		await handle.writeFile(owner, 'utf8')
		await handle.sync()
	} catch (error) {
		await handle.close().catch(() => undefined)
		// We created this path exclusively a moment ago; drop it so no empty or
		// partial record is left to block the next start.
		const current = await lstat(path).catch(() => undefined)
		if (!identity || (current?.dev === identity.dev && current.ino === identity.ino)) {
			await unlink(path).catch(() => undefined)
		}
		throw error
	}
	await handle.close()
	return { identity, owner }
}

async function releaseOwned(
	path: string,
	identity: Stats,
	owner: string,
	timeoutMs: number,
): Promise<void> {
	const current = await lstat(path)
	if (
		!current.isFile() ||
		current.isSymbolicLink() ||
		current.dev !== identity.dev ||
		current.ino !== identity.ino ||
		(await readFile(path, 'utf8')) !== owner
	) {
		throw lockError(
			path,
			`Memory operation lock ${path}: the lock owner changed before release.`,
			timeoutMs,
		)
	}
	await unlink(path)
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

/** Unlinks `path` only if it is still exactly the stale file that was inspected. */
async function unlinkIfStillStale(path: string, seen: Inspection, env: Resolved): Promise<boolean> {
	const again = await inspect(path, env)
	if (!again || !sameFile(again.stats, seen.stats) || again.content !== seen.content) return false
	if (again.staleReason === undefined) return false
	// Narrow the window further: the inode must still be the inspected one now.
	const last = await lstat(path).catch(() => undefined)
	if (!last || !sameFile(last, seen.stats)) return false
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error
	})
	return true
}

/**
 * Removes a lock whose owner is provably gone. Two processes that see the same
 * stale lock are serialised through `<lock>.break`; the lock is re-inspected
 * under it and only the inspected inode is unlinked. Returns whether the lock
 * was removed.
 */
async function breakStaleLock(
	path: string,
	seen: Inspection,
	timeoutMs: number,
	env: Resolved,
): Promise<boolean> {
	const breakPath = `${path}.break`
	let held: { identity: Stats; owner: string } | undefined
	for (let attempt = 0; attempt < 2 && !held; attempt++) {
		held = await createOwned(breakPath, env)
		if (held) break
		const breaker = await inspect(breakPath, env)
		if (!breaker) continue
		// A dead breaker's file follows the same rule, once.
		if (breaker.staleReason === undefined || !(await unlinkIfStillStale(breakPath, breaker, env))) {
			return false
		}
	}
	if (!held) return false
	try {
		const removed = await unlinkIfStillStale(path, seen, env)
		if (removed) {
			env.logger?.info('Broke an abandoned memory operation lock', {
				'namzu.store.lock_path': path,
				'namzu.store.lock_reason': seen.staleReason,
			})
		}
		return removed
	} finally {
		await releaseOwned(breakPath, held.identity, held.owner, timeoutMs).catch(() => undefined)
	}
}

/**
 * Local-filesystem exclusion for cooperating processes. Atomic rename of the
 * index alone cannot serialize the index/content read-modify-write transaction.
 * A lock whose owner is provably gone (dead pid on this host, or an owner-less
 * file older than the grace period) is broken; a live or unverifiable owner is
 * waited for until the timeout, never replaced on a guessed lease.
 */
export async function acquireMemoryOperationLock(
	path: string,
	timeoutMs: number,
	options: MemoryOperationLockOptions = {},
): Promise<() => Promise<void>> {
	const env: Resolved = {
		logger: options.logger,
		now: options.now ?? Date.now,
		isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
		hostname: options.hostname ?? osHostname(),
	}
	const deadline = performance.now() + timeoutMs
	let attempted = false
	let lastPid: number | undefined
	// The wait bound limits waiting for a live owner, not the attempt that
	// follows a successful break: the lock is free then, and breaking it can
	// itself outlast a short bound on a slow disk.
	let justBroke = false
	for (;;) {
		if (attempted && !justBroke && performance.now() >= deadline) {
			throw busyError(path, lastPid, timeoutMs)
		}
		justBroke = false
		attempted = true
		const created = await createOwned(path, env)
		if (created) {
			return () => releaseOwned(path, created.identity, created.owner, timeoutMs)
		}
		const seen = await inspect(path, env)
		if (!seen) continue
		if (!seen.stats.isFile() || seen.stats.isSymbolicLink()) {
			throw lockError(
				path,
				`The stored memory lock ${path} is not a regular file, so Namzu will not use it. Move it aside to continue.`,
				timeoutMs,
			)
		}
		lastPid = seen.pid
		if (seen.staleReason !== undefined && (await breakStaleLock(path, seen, timeoutMs, env))) {
			justBroke = true
			continue
		}
		if (performance.now() >= deadline) throw busyError(path, lastPid, timeoutMs)
		await delay(Math.min(25, Math.max(1, deadline - performance.now())))
	}
}
