import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Desktop's copy of the engine's rules for a state file in the Namzu home, for the one such file
 * Desktop writes itself (`trust.json`). The command line and the Desktop engine change the same
 * file, and Desktop cannot load their code at run time, so the protocol is repeated here and must
 * stay byte-compatible with the SDK's `utils/file-lock.ts` and `utils/state-backup.ts`:
 *
 * - Lock: `<file>.lock`, created exclusively at 0600, body `<pid>:<epoch ms>:<random hex>`. A lock
 *   whose pid has exited is reclaimed under `<file>.lock.reclaim`; a live one is waited for.
 * - Recovery copy before a write: `<home>/backups/<file>.backup.<epoch ms>`, 0600, at most one a
 *   minute, five kept, none taken when it would equal the newest.
 * - The write: a private temporary beside the file, flushed, then renamed over it.
 */

const LOCK_ATTEMPTS = 100
const LOCK_WAIT_MS = 20
const BACKUP_KEEP = 5
const BACKUP_MIN_INTERVAL_MS = 60_000

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

function reclaimIfStale(lock: string): boolean {
	let observed: string
	try {
		observed = readFileSync(lock, 'utf8')
	} catch {
		return true
	}
	const pid = pidOf(observed)
	if (pid === undefined || !processIsDead(pid)) return false
	const guard = `${lock}.reclaim`
	let fd: number
	try {
		fd = openSync(guard, 'wx', 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		try {
			const holder = pidOf(readFileSync(guard, 'utf8'))
			if (holder !== undefined && processIsDead(holder)) rmSync(guard, { force: true })
		} catch {
			// The guard vanished; the next attempt decides.
		}
		return false
	}
	try {
		writeSync(fd, `${process.pid}`)
		closeSync(fd)
		let again: string | undefined
		try {
			again = readFileSync(lock, 'utf8')
		} catch {
			return true
		}
		if (again !== observed) return false
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
			writeSync(fd, token)
		} finally {
			closeSync(fd)
		}
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

const BACKUP_NAME = /\.backup\.(\d{1,16})$/

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
		const prefix = `${name}.backup.`
		const existing = (() => {
			try {
				return readdirSync(dir)
			} catch {
				return []
			}
		})()
			.filter((entry) => entry.startsWith(prefix) && BACKUP_NAME.test(entry))
			.map((entry) => ({ path: join(dir, entry), at: Number(entry.slice(prefix.length)) }))
			.sort((a, b) => b.at - a.at)
		const newest = existing[0]
		if (newest && at >= newest.at && at - newest.at < BACKUP_MIN_INTERVAL_MS) return undefined
		let bytes: Buffer
		try {
			bytes = readFileSync(file)
		} catch {
			return undefined
		}
		if (newest) {
			try {
				if (Buffer.compare(readFileSync(newest.path), bytes) === 0) return undefined
			} catch {
				// An unreadable newest copy is no reason to skip a new one.
			}
		}
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		let stamp = at
		while (existing.some((copy) => copy.at === stamp)) stamp += 1
		const path = join(dir, `${prefix}${stamp}`)
		writeEngineStateFile(path, bytes)
		if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
		for (const old of [{ path, at: stamp }, ...existing].slice(BACKUP_KEEP))
			rmSync(old.path, { force: true })
		return path
	} catch {
		return undefined
	}
}
