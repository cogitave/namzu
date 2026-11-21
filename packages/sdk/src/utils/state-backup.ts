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
	utimesSync,
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
 * - `<home>/backups/<file>.corrupted.<epoch ms>`: a file that could not be
 *   read, kept before anything is allowed to replace it.
 *
 * The number in a name only ever grows for a file: a copy is named at least
 * one more than the newest of its kind, also when the clock went back, so the
 * highest number is always the copy written last. The copy's modification
 * time is set to when it was taken, and the one-a-minute limit is measured
 * from that, not from the name.
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

export interface StateBackupFileOptions extends StateBackupOptions {
	/**
	 * Applied to the file's text before it is copied, for a secret the coming
	 * write removes and that must not reach a copy either.
	 */
	readonly redact?: (text: string) => string
}

export interface StateFileCopy {
	readonly path: string
	/** The base name of the file this copies, such as `trust.json`. */
	readonly file: string
	readonly kind: 'backup' | 'corrupted'
	/** Epoch milliseconds from the copy's name; the highest is the copy written last. */
	readonly at: number
	/** When the copy was taken (its modification time), for saying so to a person. */
	readonly takenAt: number
}

export function stateBackupsDir(home: string): string {
	return join(home, STATE_BACKUPS_DIR)
}

const COPY_NAME = /^(.+?)\.(backup|corrupted)\.(\d{1,16})$/

function parseCopy(dir: string, entry: string): StateFileCopy | undefined {
	const match = COPY_NAME.exec(entry)
	if (!match) return undefined
	const at = Number(match[3])
	if (!Number.isSafeInteger(at)) return undefined
	const path = join(dir, entry)
	let takenAt = at
	try {
		takenAt = statSync(path).mtimeMs
	} catch {
		// Listed a moment ago; the name's number is the best left.
	}
	const kind = match[2] === 'backup' ? 'backup' : 'corrupted'
	return { path, file: match[1] as string, kind, at, takenAt }
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

/**
 * Write a private copy and prove it: a copy that keeps a wide mode, or does not
 * read back as `bytes`, is removed. `takenAt` becomes its modification time.
 */
function writePrivateCopy(path: string, bytes: Uint8Array, takenAt: number): void {
	writeFileAtomicSync(path, bytes, { mode: FILE_MODE })
	try {
		if (process.platform !== 'win32') {
			if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, FILE_MODE)
			if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} could not be made private`)
		}
		if (!sameBytes(path, bytes)) throw new Error(`${path} does not read back as what was written`)
		const seconds = takenAt / 1000
		utimesSync(path, seconds, seconds)
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

/**
 * A name not yet taken, numbered at least one past the newest copy of its kind,
 * so the order of the names is the order the copies were written in.
 */
function freshName(
	dir: string,
	file: string,
	kind: StateFileCopy['kind'],
	at: number,
	newest: StateFileCopy | undefined,
): string {
	let stamp = newest ? Math.max(at, newest.at + 1) : at
	for (;;) {
		const candidate = join(dir, `${file}.${kind}.${stamp}`)
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
 * does not exist or is empty, when the newest copy was taken less than a minute ago, or
 * when it is the same as the newest copy. A newest copy taken "later" than now
 * (the clock went back) does not hold the next one off. Never throws: a copy
 * that could not be taken must not stop the write it was protecting. Returns
 * the copy written, if any.
 */
export function backupStateFile(file: string, options: StateBackupFileOptions): string | undefined {
	try {
		const now = options.now?.() ?? Date.now()
		const name = basename(file)
		const existing = listStateFileCopies(options.home, name).filter((c) => c.kind === 'backup')
		const newest = existing[0]
		const since = newest ? now - newest.takenAt : Number.POSITIVE_INFINITY
		if (since >= 0 && since < STATE_BACKUP_MIN_INTERVAL_MS) return undefined
		let bytes: Buffer
		try {
			bytes = readFileSync(file)
		} catch {
			return undefined
		}
		// An empty file holds nothing to go back to, and must not become "the newest copy".
		if (bytes.toString('utf8').trim() === '') return undefined
		if (options.redact) bytes = Buffer.from(options.redact(bytes.toString('utf8')), 'utf8')
		if (newest && sameBytes(newest.path, bytes)) return undefined
		const dir = ensureDir(options.home)
		const path = freshName(dir, name, 'backup', now, newest)
		writePrivateCopy(path, bytes, now)
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
 * Keep the bytes of a file that could not be read as `<file>.corrupted.<ms>`
 * before anything may replace it. A file already kept with the same bytes is
 * not copied again, so a damaged file is reported once, not on every write.
 * The copy is read back and compared before this returns. Throws when no copy
 * can be made; the caller must then refuse its write.
 */
export function preserveUnreadableStateFile(
	file: string,
	options: StateBackupOptions,
): { readonly path: string; readonly fresh: boolean } {
	const bytes = readFileSync(file)
	const name = basename(file)
	const kept = listStateFileCopies(options.home, name).filter((c) => c.kind === 'corrupted')
	const same = kept.find((copy) => sameBytes(copy.path, bytes))
	if (same) return { path: same.path, fresh: false }
	const dir = ensureDir(options.home)
	const now = options.now?.() ?? Date.now()
	const path = freshName(dir, name, 'corrupted', now, kept[0])
	writePrivateCopy(path, bytes, now)
	prune(
		listStateFileCopies(options.home, name).filter((c) => c.kind === 'corrupted'),
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
			// Rewritten in place, it keeps the time it was taken.
			else if (next !== text) writePrivateCopy(copy.path, Buffer.from(next, 'utf8'), copy.takenAt)
		} catch {
			rmSync(copy.path, { force: true })
		}
	}
}
