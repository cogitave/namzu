import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The cache keeps what the index read — string literals included, secrets in
 * them too — for as long as it lives, so it must not live forever.
 *
 * Two bounds, applied once per provider when it first opens a cache file:
 *
 * - **Age**: a database not used for `maxAgeDays` (default 30) is removed.
 *   "Used" is tracked by touching the file when it is opened, since a read-only
 *   session would otherwise leave its modification time at the last write.
 * - **Size**: when the cache directory holds more than `maxBytes` (default
 *   2 GiB), the least recently used databases go until it fits.
 *
 * The database being opened is never removed, and neither is one touched in the
 * last hour: another process may be using it. Best effort — a file that cannot
 * be removed is left, and errors never reach the caller.
 */

export const DEFAULT_CACHE_MAX_AGE_DAYS = 30
export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const RECENT_MS = 60 * 60 * 1000

export interface EvictionPolicy {
	readonly maxAgeDays: number
	readonly maxBytes: number
}

/** Mark a cache file as used now. */
export async function touchCache(location: string): Promise<void> {
	const now = new Date()
	await utimes(location, now, now).catch(() => undefined)
}

export async function evictCaches(
	cacheDir: string,
	keep: string,
	policy: EvictionPolicy,
	now = Date.now(),
): Promise<string[]> {
	const removed: string[] = []
	let names: string[]
	try {
		names = (await readdir(cacheDir)).filter((n) => n.endsWith('.sqlite'))
	} catch {
		return removed
	}
	const entries: Array<{ name: string; mtime: number; bytes: number }> = []
	for (const name of names) {
		try {
			const main = await stat(join(cacheDir, name))
			// The write-ahead log is part of the database.
			const wal = await stat(join(cacheDir, `${name}-wal`)).catch(() => undefined)
			entries.push({ name, mtime: main.mtimeMs, bytes: main.size + (wal?.size ?? 0) })
		} catch {
			// Gone already.
		}
	}
	const drop = async (name: string): Promise<void> => {
		for (const suffix of ['', '-wal', '-shm'])
			await rm(join(cacheDir, `${name}${suffix}`), { force: true }).catch(() => undefined)
		removed.push(name)
	}
	const evictable = (e: { name: string; mtime: number }): boolean =>
		e.name !== keep && now - e.mtime > RECENT_MS

	const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1000
	let live = entries
	for (const e of entries) {
		if (evictable(e) && e.mtime < cutoff) await drop(e.name)
	}
	live = entries.filter((e) => !removed.includes(e.name))
	let total = live.reduce((sum, e) => sum + e.bytes, 0)
	for (const e of [...live].sort((a, b) => a.mtime - b.mtime)) {
		if (total <= policy.maxBytes) break
		if (!evictable(e)) continue
		await drop(e.name)
		total -= e.bytes
	}
	return removed
}
