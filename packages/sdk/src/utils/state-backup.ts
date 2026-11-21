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

import { temporaryPathFor } from './atomic-write.js'

/**
 * Recovery copies of the small state files in the Namzu home whose loss hurts
 * (settings, folder trust, server approvals, accounts, the provider chain).
 *
 * - `<home>/backups/<file>.backup.<epoch ms>`: the file as it was just before
 *   a write. At most one per {@link STATE_BACKUP_MIN_INTERVAL_MS} per file, the
 *   newest {@link STATE_BACKUP_KEEP} kept. A copy identical to the newest one is
 *   not taken again, so the kept copies are distinct states.
 * - `<home>/backups/<file>.corrupt-<epoch ms>`: a file that could not be read,
 *   kept before anything is allowed to replace it.
 *
 * Every copy is written private (0600) whatever the source's mode, because
 * some of these files hold keys. Nothing is restored automatically: restoring
 * is copying one of these back over the file.
 */
export const STATE_BACKUPS_DIR = 'backups'
export const STATE_BACKUP_KEEP = 5
export const STATE_BACKUP_MIN_INTERVAL_MS = 60_000

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export interface StateBackupOptions {
	/** The Namzu home; copies go to `<home>/backups/`. */
	readonly home: string
	/** Epoch milliseconds; injected so a test never depends on the clock. */
	readonly now?: () => number
}

export interface StateFileCopy {
	readonly path: string
	/** The base name of the file this copies, such as `trust.json`. */
	readonly file: string
	readonly kind: 'backup' | 'corrupt'
	/** Epoch milliseconds from the copy's name. */
	readonly at: number
}

export function stateBackupsDir(home: string): string {
	return join(home, STATE_BACKUPS_DIR)
}

const COPY_NAME = /^(.+?)(?:\.backup\.|\.corrupt-)(\d{1,16})$/

function parseCopy(dir: string, entry: string): StateFileCopy | undefined {
	const match = COPY_NAME.exec(entry)
	if (!match) return undefined
	const at = Number(match[2])
	if (!Number.isSafeInteger(at)) return undefined
	const file = match[1] as string
	const kind = entry.startsWith(`${file}.backup.`) ? 'backup' : 'corrupt'
	return { path: join(dir, entry), file, kind, at }
}

/** The copies in `<home>/backups/`, newest first; only those of `file` when it is given. */
export function listStateFileCopies(home: string, file?: string): StateFileCopy[] {
	const dir = stateBackupsDir(home)
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return []
	}
	const copies: StateFileCopy[] = []
	for (const entry of entries) {
		const copy = parseCopy(dir, entry)
		if (copy && (file === undefined || copy.file === file)) copies.push(copy)
	}
	return copies.sort((a, b) => b.at - a.at || (a.path < b.path ? 1 : -1))
}

/**
 * Write `content` to `file` through a private temporary beside it: the body is
 * flushed to disk before the rename, so a reader sees the old file or the
 * whole new one, also after a power loss. The directory is flushed too where
 * the platform allows it.
 */
export function writeFileAtomicSync(
	file: string,
	content: string | Uint8Array,
	options: { readonly mode?: number } = {},
): void {
	const temporary = temporaryPathFor(file)
	let fd: number | undefined
	try {
		fd = openSync(temporary, 'wx', options.mode ?? FILE_MODE)
		const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
		let written = 0
		while (written < bytes.length) written += writeSync(fd, bytes, written)
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		renameSync(temporary, file)
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// The write already failed; that is the error to report.
			}
		}
		rmSync(temporary, { force: true })
		throw error
	}
	syncDirectoryQuietly(dirname(file))
}

function syncDirectoryQuietly(directory: string): void {
	if (process.platform === 'win32') return
	let fd: number | undefined
	try {
		fd = openSync(directory, 'r')
		fsyncSync(fd)
	} catch {
		// The file itself is already flushed; the directory entry is the filesystem's.
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}

/** Write a private copy and prove it private: a copy that keeps a wide mode is removed. */
function writePrivateCopy(path: string, bytes: Uint8Array): void {
	writeFileAtomicSync(path, bytes, { mode: FILE_MODE })
	if (process.platform === 'win32') return
	try {
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, FILE_MODE)
		if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} could not be made private`)
	} catch (error) {
		rmSync(path, { force: true })
		throw error
	}
}

function sameBytes(path: string, bytes: Uint8Array): boolean {
	try {
		if (statSync(path).size !== bytes.length) return false
		return Buffer.compare(readFileSync(path), bytes) === 0
	} catch {
		return false
	}
}

function prune(copies: readonly StateFileCopy[], keep: number): void {
	for (const old of copies.slice(keep)) rmSync(old.path, { force: true })
}

/** A name not yet taken: two copies within one millisecond get consecutive stamps. */
function freshName(dir: string, file: string, separator: string, at: number): string {
	let stamp = at
	for (;;) {
		const candidate = join(dir, `${file}${separator}${stamp}`)
		try {
			statSync(candidate)
			stamp += 1
		} catch {
			return candidate
		}
	}
}

function ensureDir(home: string): string {
	const dir = stateBackupsDir(home)
	mkdirSync(dir, { recursive: true, mode: DIR_MODE })
	if (process.platform !== 'win32') {
		try {
			if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, DIR_MODE)
		} catch {
			// The copies themselves are private; a wide folder is reported by doctor.
		}
	}
	return dir
}

/**
 * Take a recovery copy of `file` before it is replaced. Skipped when the file
 * does not exist, when the newest copy is younger than a minute, or when it is
 * the same as the newest copy. Never throws: a copy that could not be taken
 * must not stop the write it was protecting. Returns the copy written, if any.
 */
export function backupStateFile(file: string, options: StateBackupOptions): string | undefined {
	try {
		const now = options.now?.() ?? Date.now()
		const name = basename(file)
		const existing = listStateFileCopies(options.home, name).filter((c) => c.kind === 'backup')
		const newest = existing[0]
		if (newest && now >= newest.at && now - newest.at < STATE_BACKUP_MIN_INTERVAL_MS)
			return undefined
		let bytes: Buffer
		try {
			bytes = readFileSync(file)
		} catch {
			return undefined
		}
		if (newest && sameBytes(newest.path, bytes)) return undefined
		const dir = ensureDir(options.home)
		const path = freshName(dir, name, '.backup.', now)
		writePrivateCopy(path, bytes)
		prune(
			listStateFileCopies(options.home, name).filter((c) => c.kind === 'backup'),
			STATE_BACKUP_KEEP,
		)
		return path
	} catch {
		return undefined
	}
}

/**
 * Keep the bytes of a file that could not be read as `<file>.corrupt-<ms>`
 * before anything may replace it. A file already kept with the same bytes is
 * not copied again, so a damaged file is reported once, not on every write.
 * Throws when no copy can be made; the caller must then refuse its write.
 */
export function preserveUnreadableStateFile(
	file: string,
	options: StateBackupOptions,
): { readonly path: string; readonly fresh: boolean } {
	const bytes = readFileSync(file)
	const name = basename(file)
	const kept = listStateFileCopies(options.home, name).filter((c) => c.kind === 'corrupt')
	const same = kept.find((copy) => sameBytes(copy.path, bytes))
	if (same) return { path: same.path, fresh: false }
	const dir = ensureDir(options.home)
	const path = freshName(dir, name, '.corrupt-', options.now?.() ?? Date.now())
	writePrivateCopy(path, bytes)
	prune(
		listStateFileCopies(options.home, name).filter((c) => c.kind === 'corrupt'),
		STATE_BACKUP_KEEP,
	)
	return { path, fresh: true }
}

/**
 * Change every recovery copy of `file`, for a secret that must not outlive its
 * removal in an old copy. `edit` gets a copy's text and returns its new text,
 * or `undefined` to remove that copy. A copy that cannot be rewritten is
 * removed rather than left holding what was asked to go.
 */
export function rewriteStateFileBackups(
	home: string,
	file: string,
	edit: (text: string) => string | undefined,
): void {
	for (const copy of listStateFileCopies(home, file)) {
		try {
			const text = readFileSync(copy.path, 'utf8')
			const next = edit(text)
			if (next === undefined) rmSync(copy.path, { force: true })
			else if (next !== text) writePrivateCopy(copy.path, Buffer.from(next, 'utf8'))
		} catch {
			rmSync(copy.path, { force: true })
		}
	}
}
