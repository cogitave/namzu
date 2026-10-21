import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
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
 * without following a final link (`O_NOFOLLOW`), checks that the opened
 * descriptor is the file `lstat` saw, and checks that the canonical path is
 * inside the canonical root both before and after the read (the "after" is for
 * a parent directory swapped between the check and the open, which
 * `O_NOFOLLOW` does not cover).
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

/** `O_NOFOLLOW` does not exist on Windows; there `lstat` and the realpath checks carry it. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export async function readRegular(rootReal: string, abs: string): Promise<SafeRead> {
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
		const handle = await open(abs, constants.O_RDONLY | NOFOLLOW)
		try {
			const opened = await handle.stat()
			// The descriptor must be the file `lstat` described. A swap between
			// the two shows up as a different inode.
			if (
				opened.isFile() === false ||
				(before.ino !== 0 && (opened.ino !== before.ino || opened.dev !== before.dev))
			) {
				return { ok: false, why: 'link' }
			}
			const buffer = await handle.readFile()
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
