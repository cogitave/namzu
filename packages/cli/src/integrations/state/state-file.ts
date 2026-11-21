/**
 * The rules for the small state files in the Namzu home that more than one
 * Namzu process changes: the terminal, the Desktop engine and `exec` can all
 * run at once.
 *
 * - One change at a time. A change takes `<file>.lock` (the SDK's lock-file
 *   protocol), reads the file again under it, applies its one edit and writes
 *   the whole file through a flushed temporary and a rename. Two processes
 *   that change the file together both keep their change.
 * - A recovery copy first. The file as it was goes to
 *   `<home>/backups/<file>.backup.<ms>` (at most one a minute, five kept).
 * - Never an overwrite of what could not be read. A file that exists but does
 *   not read as the expected shape is kept as `<home>/backups/<file>.corrupted.<ms>`
 *   and the change is refused with a sentence saying where the copy is. Only an
 *   explicit "start a new list" replaces it, after that copy reads back equal.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import {
	FileLockError,
	backupStateFile,
	listStateFileCopies,
	lockPathFor,
	preserveUnreadableStateFile,
	withFileLockSync,
	writeFileAtomicSync,
} from '@namzu/sdk'

/** Every writer is synchronous from read to rename, so a held lock clears in milliseconds. */
const LOCK_ATTEMPTS = 100
const LOCK_WAIT_MS = 20

function pause(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS)
}

/** Shows a path to a person; the terminal shortens the home folder to `~`. */
export type ShowPath = (path: string) => string

const asIs: ShowPath = (path) => path

/** Raised when another process kept the file's lock for the whole wait. */
export class StateFileBusyError extends Error {
	override readonly name = 'StateFileBusyError'
	constructor(readonly file: string) {
		super(busySentence(file, asIs))
	}
	sentence(show: ShowPath): string {
		return busySentence(this.file, show)
	}
}

function busySentence(file: string, show: ShowPath): string {
	return `${show(file)} is being saved by another Namzu process right now, so this change was not made. Try again in a moment.`
}

/** A recovery copy as a refusal names it: where it is and when it was taken. */
export interface RecoveryCopy {
	readonly path: string
	readonly takenAt: number
}

/** `2026-11-21 16:03` in local time: when a recovery copy was taken. */
export function copyTime(ms: number): string {
	const at = new Date(ms)
	const two = (n: number) => String(n).padStart(2, '0')
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/**
 * Where the newest recovery copy is and what it holds. A copy is the file as it
 * was just before a change, at most one a minute, so the change it was taken
 * for, and any after it, are not in it: the sentence says so rather than call
 * it the last good state.
 */
export function recoveryCopySentence(file: string, copy: RecoveryCopy, show: ShowPath): string {
	return `The newest recovery copy is ${show(copy.path)}, the file as it was before a change at ${copyTime(copy.takenAt)}; that change and any later one are not in it. To go back to it, copy it over ${show(file)}.`
}

const DEFAULT_REMEDY = 'Fix or remove the file, then try again.'

/** Raised instead of replacing a file that exists but could not be read. */
export class StateFileUnreadableError extends Error {
	override readonly name = 'StateFileUnreadableError'
	constructor(
		readonly file: string,
		readonly reason: string,
		/** Where the unreadable bytes are kept; absent when no copy could be made. */
		readonly copy: string | undefined,
		/** The newest recovery copy taken before the damage, if any. */
		readonly backup: RecoveryCopy | undefined,
		/** The last sentence: what the person can do about it here. */
		readonly remedy: string = DEFAULT_REMEDY,
	) {
		super(unreadableSentence(file, reason, copy, backup, remedy, asIs))
	}
	sentence(show: ShowPath): string {
		return unreadableSentence(this.file, this.reason, this.copy, this.backup, this.remedy, show)
	}
	/** The same refusal with the way out that the place showing it offers. */
	withRemedy(remedy: string): StateFileUnreadableError {
		return new StateFileUnreadableError(this.file, this.reason, this.copy, this.backup, remedy)
	}
}

function unreadableSentence(
	file: string,
	reason: string,
	copy: string | undefined,
	backup: RecoveryCopy | undefined,
	remedy: string,
	show: ShowPath,
): string {
	const parts = [`${show(file)} could not be read (${reason}), so it was not changed.`]
	if (copy) parts.push(`Its contents are kept in ${show(copy)}.`)
	if (backup) parts.push(recoveryCopySentence(file, backup, show))
	parts.push(remedy)
	return parts.join(' ')
}

const held = new Map<string, number>()

export interface StateFileLockOptions {
	readonly attempts?: number
	/** Blocks between attempts; injected so a test never depends on the clock. */
	readonly wait?: (attempt: number) => void
}

/**
 * Run `operation` holding `file`'s lock. Re-entrant within this process, so a
 * change made of several smaller writes (a settings save that also moves an
 * old key) holds the lock once across all of them.
 */
export function withStateFileLock<T>(
	file: string,
	operation: () => T,
	options: StateFileLockOptions = {},
): T {
	const key = resolve(file)
	const depth = held.get(key) ?? 0
	if (depth > 0) {
		held.set(key, depth + 1)
		try {
			return operation()
		} finally {
			held.set(key, depth)
		}
	}
	mkdirSync(dirname(key), { recursive: true, mode: 0o700 })
	let entered = false
	try {
		return withFileLockSync(
			lockPathFor(key),
			() => {
				entered = true
				held.set(key, 1)
				try {
					return operation()
				} finally {
					held.delete(key)
				}
			},
			{ attempts: options.attempts ?? LOCK_ATTEMPTS, wait: options.wait ?? pause },
		)
	} catch (error) {
		if (!entered && error instanceof FileLockError) throw new StateFileBusyError(key)
		throw error
	}
}

export interface SaveStateFileOptions {
	/** The Namzu home, whose `backups/` holds the recovery copies. */
	readonly home: string
	/** Take a recovery copy of the file as it was. Default true. */
	readonly backup?: boolean
	readonly mode?: number
}

/** Replace `file` whole: a recovery copy of the old one, then a flushed temporary and a rename. */
export function saveStateFile(file: string, text: string, options: SaveStateFileOptions): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	if (options.backup !== false) backupStateFile(file, { home: options.home })
	writeFileAtomicSync(file, text, { mode: options.mode ?? 0o600 })
}

/** The newest recovery copy of `file` (by base name), taken before a write. */
export function newestStateBackup(home: string, file: string): RecoveryCopy | undefined {
	const copy = listStateFileCopies(home, basename(file)).find((c) => c.kind === 'backup')
	return copy ? { path: copy.path, takenAt: copy.takenAt } : undefined
}

/**
 * The refusal for a write over a file that could not be read. The file's bytes
 * are kept first; when even that fails the refusal still stands.
 */
export function unreadableStateFile(
	file: string,
	reason: string,
	home: string,
	remedy?: string,
): StateFileUnreadableError {
	let copy: string | undefined
	try {
		copy = preserveUnreadableStateFile(file, { home }).path
	} catch {
		copy = undefined
	}
	return new StateFileUnreadableError(file, reason, copy, newestStateBackup(home, file), remedy)
}

/**
 * Replace a file that could not be read with `text`, for a person who chose to
 * start a new one. The caller holds the file's lock and has read it as
 * unreadable. The old bytes are kept in `backups/` first and the copy is read
 * back and compared; if the file changed meanwhile, or the copy cannot be made,
 * nothing is replaced. Returns where the old file is kept.
 */
export function startNewStateFile(file: string, text: string, home: string): string {
	const before = readFileSync(file)
	const kept = preserveUnreadableStateFile(file, { home }).path
	if (!readFileSync(kept).equals(before) || !readFileSync(file).equals(before))
		throw new Error(`${file} changed while it was being kept, so it was not replaced. Try again.`)
	saveStateFile(file, text, { home, backup: false })
	return kept
}

/** Why a JSON state file did not read, in a few plain words. */
export function readFailureReason(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code
	if (code === 'EACCES' || code === 'EPERM') return 'permission denied'
	if (code === 'EISDIR') return 'it is a folder'
	if (error instanceof SyntaxError) return 'not valid JSON'
	return code ?? (error instanceof Error ? error.message : String(error))
}
