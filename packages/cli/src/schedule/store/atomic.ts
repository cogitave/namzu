/**
 * How the scheduler's files are written.
 *
 * Two rules, the ones the session lease settled on (`@namzu/sdk`
 * `store/session-log/lease.ts`):
 *
 * - A file that ARBITRATES — who started an occurrence — is published with
 *   `link` from a fully written, fsynced temporary. `link` fails with `EEXIST`
 *   when the name exists, so of any number of simultaneous writers exactly one
 *   wins, and the name never exists without its whole body. Never `wx` on the
 *   real name (a reader can see it empty) and never rename-then-read-back (two
 *   renamers can each read themselves).
 * - A file that is a VIEW or an operator-owned document — a job, a state — is
 *   replaced by an fsynced temporary and `rename`, so a reader sees the old
 *   body or the new one.
 *
 * Every file is 0600 in a 0700 directory.
 */

import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** A file newer than this reader understands. Never rewritten. */
export class ScheduleFormatError extends Error {
	override readonly name = 'ScheduleFormatError'
	constructor(
		readonly path: string,
		message: string,
	) {
		super(`${path}: ${message}`)
	}
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
}

function temporaryBeside(path: string): string {
	return join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
	)
}

function writeDurably(path: string, text: string): void {
	const fd = openSync(path, 'wx', PRIVATE_FILE_MODE)
	try {
		writeSync(fd, text)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
}

function fsyncDir(path: string): void {
	try {
		const fd = openSync(path, 'r')
		try {
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
	} catch {
		// Not every platform can fsync a directory (Windows). Best effort.
	}
}

/** Replace `path` with `value` as JSON: fsynced temporary, then rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
	ensureDir(dirname(path))
	const temporary = temporaryBeside(path)
	writeDurably(temporary, `${JSON.stringify(value, null, 2)}\n`)
	try {
		renameSync(temporary, path)
	} catch (error) {
		try {
			unlinkSync(temporary)
		} catch {}
		throw error
	}
	fsyncDir(dirname(path))
}

/**
 * Publish `value` at `path` only if nothing is there yet. `true` when this
 * call created it; `false` when the name already existed (someone else won).
 */
export function publishExclusive(path: string, value: unknown): boolean {
	ensureDir(dirname(path))
	const temporary = temporaryBeside(path)
	writeDurably(temporary, `${JSON.stringify(value)}\n`)
	try {
		linkSync(temporary, path)
		fsyncDir(dirname(path))
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw error
	} finally {
		try {
			unlinkSync(temporary)
		} catch {}
	}
}

/**
 * Read a scheduler file of `kind`, or `undefined` when there is none.
 * Refuses a newer version or another kind, naming the file.
 */
export function readVersioned<T extends { readonly v: number; readonly kind: string }>(
	path: string,
	kind: T['kind'],
): T | undefined {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new ScheduleFormatError(path, 'is not valid JSON')
	}
	const record = parsed as { v?: unknown; kind?: unknown }
	if (typeof record !== 'object' || record === null || record.kind !== kind) {
		throw new ScheduleFormatError(path, `is not a ${kind} file`)
	}
	if (typeof record.v !== 'number' || record.v > 1) {
		throw new ScheduleFormatError(
			path,
			`was written by a newer namzu (format ${String(record.v)}); this one reads format 1 and will not change it`,
		)
	}
	return parsed as T
}
