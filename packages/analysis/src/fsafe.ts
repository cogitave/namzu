import { constants, type Stats } from 'node:fs'
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'

/**
 * Reading a file the index owns, without being led out of the root.
 *
 * The walker never follows a link, but that only proves what the file WAS when
 * it was indexed. Every read after that runs against a file system someone may
 * have changed: a file replaced by a link to `~/.ssh/id_rsa`, a directory
 * swapped for a link to somewhere else. Reading through either would answer
 * with the outside file's contents, cited as an in-root path.
 *
 * So no read in this package goes through a bare `readFile`. It goes through
 * here, which refuses anything that is not a regular file by `lstat`, opens
 * without following a final link (`O_NOFOLLOW`) and without blocking on a pipe
 * swapped in (`O_NONBLOCK`), and then asks the OPEN DESCRIPTOR where it is:
 *
 * - **Linux**: `readlink(/proc/self/fd/N)` names the file the descriptor
 *   really is, whatever path components were links when it was opened. That
 *   path must be inside the canonical root. This closes the window the
 *   path-based checks leave: `O_NOFOLLOW` covers only the last component, and
 *   a middle component flipped between an inside and an outside link between
 *   the check and the open was measured to win about once per 80,000 reads.
 * - **Elsewhere**: the descriptor's device and inode must equal those of the
 *   path's canonical form, which must itself be inside the root.
 *
 * The canonical path is checked once more after the read.
 */

export type SafeRead =
	| { readonly ok: true; readonly buffer: Buffer; readonly stat: Stats }
	| { readonly ok: false; readonly why: 'missing' | 'link' | 'outside' | 'not-file' | 'unreadable' }

export function isInside(rootReal: string, candidate: string): boolean {
	return (
		candidate === rootReal ||
		candidate.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
	)
}

/** `O_NOFOLLOW` does not exist on Windows; there the inode comparison carries it. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

/**
 * Whether the open descriptor `fd` is a file inside `rootReal`.
 *
 * Exported for its tests: the race it closes cannot be provoked on demand.
 */
export async function descriptorInside(
	rootReal: string,
	fd: number,
	path: string,
	opened: { ino: number; dev: number },
): Promise<boolean> {
	if (process.platform === 'linux') {
		try {
			const target = await readlink(`/proc/self/fd/${fd}`)
			// A file unlinked after opening reads "… (deleted)"; it is not at its path any more.
			return !target.endsWith(' (deleted)') && isInside(rootReal, target)
		} catch {
			// No /proc (a restricted container): fall back to the portable check.
		}
	}
	try {
		const canonical = await realpath(path)
		if (!isInside(rootReal, canonical)) return false
		const now = await stat(canonical)
		return now.ino === opened.ino && now.dev === opened.dev
	} catch {
		return false
	}
}

/**
 * Read a regular file inside the root. `limit` reads at most that many bytes
 * from the start (a file's first line, say) and still makes every check the
 * whole-file read makes.
 */
export async function readRegular(
	rootReal: string,
	abs: string,
	limit?: number,
): Promise<SafeRead> {
	let before: Stats
	try {
		before = await lstat(abs)
	} catch (err) {
		return {
			ok: false,
			why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
		}
	}
	if (before.isSymbolicLink()) return { ok: false, why: 'link' }
	if (!before.isFile()) return { ok: false, why: 'not-file' }
	try {
		if (!isInside(rootReal, await realpath(abs))) return { ok: false, why: 'outside' }
		const handle = await open(abs, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
		try {
			const opened = await handle.stat()
			// Decided from the descriptor, not the path: a FIFO or device swapped in
			// after `lstat` is refused here, and the open above did not block on it.
			if (!opened.isFile()) return { ok: false, why: 'not-file' }
			// The descriptor must be the file `lstat` described.
			if (before.ino !== 0 && (opened.ino !== before.ino || opened.dev !== before.dev)) {
				return { ok: false, why: 'link' }
			}
			if (!(await descriptorInside(rootReal, handle.fd, abs, opened)))
				return { ok: false, why: 'outside' }
			let buffer: Buffer
			if (limit === undefined) buffer = await handle.readFile()
			else {
				const chunk = Buffer.alloc(Math.min(limit, opened.size))
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
				buffer = chunk.subarray(0, bytesRead)
			}
			if (!isInside(rootReal, await realpath(abs))) return { ok: false, why: 'outside' }
			return { ok: true, buffer, stat: opened }
		} finally {
			await handle.close()
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ELOOP') return { ok: false, why: 'link' }
		if (code === 'ENOENT') return { ok: false, why: 'missing' }
		return { ok: false, why: 'unreadable' }
	}
}

/** What a file is now, without reading it: for the cheap staleness check on a page of results. */
export type Condition = 'same' | 'changed' | 'deleted' | 'violation'

export async function conditionOf(
	rootReal: string,
	abs: string,
	recorded: { size: number; mtimeMs: number },
): Promise<Condition> {
	let s: Stats
	try {
		s = await lstat(abs)
	} catch {
		return 'deleted'
	}
	if (!s.isFile()) return 'violation'
	try {
		if (!isInside(rootReal, await realpath(abs))) return 'violation'
	} catch {
		return 'deleted'
	}
	return s.size === recorded.size && s.mtimeMs === recorded.mtimeMs ? 'same' : 'changed'
}

/** Convert a path under `root` to the POSIX relative form the store keys on. */
export function toRel(root: string, abs: string): string | undefined {
	if (abs === root) return ''
	const prefix = root.endsWith(sep) ? root : root + sep
	if (!abs.startsWith(prefix)) return undefined
	return abs.slice(prefix.length).split(sep).join('/')
}
