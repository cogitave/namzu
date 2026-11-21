import { randomBytes } from 'node:crypto'
import {
	type Stats,
	chmodSync,
	closeSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isMainThread } from 'node:worker_threads'

/**
 * Desktop's copy of the engine's rules for a state file in the Namzu home, for the one such file
 * Desktop writes itself (`trust.json`). The command line and the Desktop engine change the same
 * file, and Desktop cannot load their code at run time, so the protocol is repeated here and must
 * stay byte-compatible with the SDK's `utils/file-lock.ts` and `utils/state-backup.ts`:
 *
 * - Lock: `<file>.lock`, created exclusively at 0600, body `<pid>:<epoch ms>:<random hex>`; a
 *   creator whose body write fails removes it again. A stale lock is reclaimed under
 *   `<file>.lock.reclaim`: its pid has exited, it records no pid and its time is more than ten
 *   seconds from now, or it records this process's pid and this process does not hold it. A
 *   live one is waited for.
 * - Recovery copy before a write: `<home>/backups/<file>.backup.<epoch ms>`, 0600, at most one a
 *   minute (measured from the copy's modification time, which is set to when it was taken), five
 *   kept, none taken when it would equal the newest or the file is empty. A new copy is numbered
 *   at least one past the newest, so the highest number is the copy written last.
 * - A file that cannot be read is kept as `<home>/backups/<file>.corrupted.<epoch ms>` (once per
 *   distinct content, five kept, read back before it counts) before anything may replace it.
 * - The write: a private temporary beside the file, flushed, then renamed over it.
 */

const LOCK_ATTEMPTS = 100
const LOCK_WAIT_MS = 20
const BACKUP_KEEP = 5
const BACKUP_MIN_INTERVAL_MS = 60_000
const EMPTY_LOCK_GRACE_MS = 10_000

/**
 * The bodies of the locks this process holds. The same registry the engine's SDK keeps (one key
 * on `globalThis`), so a lock with this process's pid that neither holds is known to be left over.
 */
const HELD_KEY = Symbol.for('namzu.file-lock.held')
function heldBodies(): Set<string> {
	const scope = globalThis as { [HELD_KEY]?: Set<string> }
	scope[HELD_KEY] ??= new Set<string>()
	return scope[HELD_KEY]
}

export class EngineStateFileBusyError extends Error {
	override readonly name = 'EngineStateFileBusyError'
}

export interface EngineStateLockOptions {
	readonly attempts?: number
	/** Blocks between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => void
}

function pause(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS)
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
		return (error as NodeJS.ErrnoException).code === 'ESRCH'
	}
}

interface LockSighting {
	readonly body: string
	readonly stat: Stats
}

function sight(path: string): LockSighting | undefined {
	try {
		const stat = statSync(path)
		return { body: readFileSync(path, 'utf8'), stat }
	} catch {
		return undefined
	}
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

function isStale(seen: LockSighting, now: number): boolean {
	const pid = pidOf(seen.body)
	if (pid === undefined) return Math.abs(now - seen.stat.mtimeMs) > EMPTY_LOCK_GRACE_MS
	if (pid === process.pid) return isMainThread && !heldBodies().has(seen.body)
	return processIsDead(pid)
}

function writeBody(fd: number, body: string): void {
	const bytes = Buffer.from(body, 'utf8')
	let written = 0
	while (written < bytes.length) written += writeSync(fd, bytes, written)
}

function reclaimIfStale(lock: string): boolean {
	const seen = sight(lock)
	if (seen === undefined) return true
	if (!isStale(seen, Date.now())) return false
	const guard = `${lock}.reclaim`
	let fd: number
	try {
		fd = openSync(guard, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		const holder = sight(guard)
		if (holder && isStale(holder, Date.now())) rmSync(guard, { force: true })
		return false
	}
	try {
		try {
			writeBody(fd, `${process.pid}`)
		} finally {
			closeSync(fd)
		}
		const again = sight(lock)
		if (again === undefined) return true
		const unchanged =
			again.body === seen.body &&
			sameFile(again.stat, seen.stat) &&
			again.stat.mtimeMs === seen.stat.mtimeMs &&
			again.stat.size === seen.stat.size
		if (!unchanged) return false
		rmSync(lock, { force: true })
		return true
	} finally {
		rmSync(guard, { force: true })
	}
}

function acquire(lock: string): string | undefined {
	const token = `${process.pid}:${Date.now()}:${randomBytes(12).toString('hex')}`
	for (let pass = 0; pass < 2; pass++) {
		let fd: number
		try {
			fd = openSync(lock, 'wx', 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			if (pass === 0 && reclaimIfStale(lock)) continue
			return undefined
		}
		try {
			writeBody(fd, token)
		} catch (error) {
			// A full disk creates the file and then fails its body: an empty lock left behind would
			// refuse every later change, so it goes now, while it is still the file made here.
			try {
				if (sameFile(fstatSync(fd), statSync(lock))) rmSync(lock, { force: true })
			} catch {
				// Already gone, or someone else's now.
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

/** Runs `operation` holding `<file>.lock`, after the engine's own writers have let go of it. */
export function withEngineStateLock<T>(
	file: string,
	operation: () => T,
	options: EngineStateLockOptions = {},
): T {
	const lock = `${file}.lock`
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	const attempts = Math.max(1, options.attempts ?? LOCK_ATTEMPTS)
	let token: string | undefined
	for (let attempt = 0; attempt < attempts; attempt++) {
		token = acquire(lock)
		if (token !== undefined) break
		if (attempt + 1 < attempts) (options.wait ?? pause)(attempt)
	}
	if (token === undefined)
		throw new EngineStateFileBusyError(
			'Namzu is saving this list in another window right now, so nothing was changed. Try again in a moment.',
		)
	try {
		return operation()
	} finally {
		heldBodies().delete(token)
		try {
			if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
		} catch {
			// Already gone; the work has its result.
		}
	}
}

/** Writes `text` through a flushed private temporary and a rename: the old file or the whole new one. */
export function writeEngineStateFile(file: string, text: string | Uint8Array): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
	let fd: number | undefined
	try {
		fd = openSync(temporary, 'wx', 0o600)
		const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
		let written = 0
		while (written < bytes.length) written += writeSync(fd, bytes, written)
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		renameSync(temporary, file)
	} catch (error) {
		if (fd !== undefined) closeSync(fd)
		rmSync(temporary, { force: true })
		throw error
	}
}

interface Copy {
	readonly path: string
	/** The number in the name: the highest is the copy written last. */
	readonly at: number
}

/** The copies of `name` of one kind in `dir`, the one written last first. */
function copiesOf(dir: string, name: string, kind: 'backup' | 'corrupted'): Copy[] {
	const prefix = `${name}.${kind}.`
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return []
	}
	return entries
		.filter((entry) => entry.startsWith(prefix) && /^\d{1,16}$/.test(entry.slice(prefix.length)))
		.map((entry) => ({ path: join(dir, entry), at: Number(entry.slice(prefix.length)) }))
		.sort((a, b) => b.at - a.at)
}

function sameBytes(path: string, bytes: Uint8Array): boolean {
	try {
		return Buffer.compare(readFileSync(path), bytes) === 0
	} catch {
		return false
	}
}

/** Writes a private copy numbered past `newest`, proves it, and stamps it with when it was taken. */
function writeCopy(
	dir: string,
	name: string,
	kind: 'backup' | 'corrupted',
	bytes: Uint8Array,
	at: number,
	existing: readonly Copy[],
): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const newest = existing[0]
	let stamp = newest ? Math.max(at, newest.at + 1) : at
	while (existing.some((copy) => copy.at === stamp)) stamp += 1
	const path = join(dir, `${name}.${kind}.${stamp}`)
	writeEngineStateFile(path, bytes)
	try {
		if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
		if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0)
			throw new Error(`${path} could not be made private`)
		if (!sameBytes(path, bytes)) throw new Error(`${path} does not read back as what was written`)
		utimesSync(path, at / 1000, at / 1000)
	} catch (error) {
		rmSync(path, { force: true })
		throw error
	}
	for (const old of [{ path, at: stamp }, ...existing].slice(BACKUP_KEEP))
		rmSync(old.path, { force: true })
	return path
}

/**
 * Keeps the file as it was in `<namzuHome>/backups/` before a write. Never throws: a copy that
 * could not be taken does not stop the change it was protecting.
 */
export function backupEngineStateFile(
	file: string,
	namzuHome: string,
	now: () => number = Date.now,
): string | undefined {
	try {
		const at = now()
		const name = basename(file)
		const dir = join(namzuHome, 'backups')
		const existing = copiesOf(dir, name, 'backup')
		const newest = existing[0]
		if (newest) {
			let takenAt = newest.at
			try {
				takenAt = statSync(newest.path).mtimeMs
			} catch {
				// Listed a moment ago; the name's number is the best left.
			}
			const since = at - takenAt
			if (since >= 0 && since < BACKUP_MIN_INTERVAL_MS) return undefined
		}
		let bytes: Buffer
		try {
			bytes = readFileSync(file)
		} catch {
			return undefined
		}
		if (bytes.toString('utf8').trim() === '') return undefined
		if (newest && sameBytes(newest.path, bytes)) return undefined
		return writeCopy(dir, name, 'backup', bytes, at, existing)
	} catch {
		return undefined
	}
}

/**
 * Keeps the bytes of a file that could not be read as `<namzuHome>/backups/<file>.corrupted.<ms>`,
 * read back and compared, before anything may replace it; the same bytes already kept are not
 * copied again. Throws when no copy can be made, so the caller replaces nothing.
 */
export function preserveUnreadableEngineStateFile(
	file: string,
	namzuHome: string,
	now: () => number = Date.now,
): string {
	const bytes = readFileSync(file)
	const name = basename(file)
	const dir = join(namzuHome, 'backups')
	const existing = copiesOf(dir, name, 'corrupted')
	const same = existing.find((copy) => sameBytes(copy.path, bytes))
	if (same) return same.path
	return writeCopy(dir, name, 'corrupted', bytes, now(), existing)
}
