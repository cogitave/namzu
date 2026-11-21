/**
 * Where a "don't ask again" answer is written, and how the file got there.
 *
 * An allow rule is written to the project's local settings file,
 * `.namzu/settings.local.json`, which holds the same keys as the project's
 * shared files and is read as the local layer of the config cascade. Namzu keeps
 * git from tracking it by adding `**` + `/.namzu/settings.local.json*` to the
 * person's GLOBAL git ignore (`core.excludesFile`, else
 * `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`) when the folder is
 * in a git work tree and the file is neither ignored nor tracked yet. The star
 * covers the lock and staging files beside it.
 *
 * One writer, `updateLocalSettings`, does every write: it holds a lock beside
 * the file, re-reads the file under it, applies the change, writes every byte of
 * a staging file in `.namzu` (mode 0600), flushes it to disk, reads it back and
 * compares it, checks that the file still holds what was read, renames the
 * staging file over it, and reads the result back. A file that is not valid JSON,
 * or not UTF-8 text, is left alone and the answer holds for the session only. A
 * `.namzu` that is a link or a file is refused, and so is a settings file that
 * is a link.
 *
 * `namzu.config.local.json` at the top of the folder is where an earlier Namzu
 * wrote these answers. `moveLegacyLocalConfig` moves it once, in a trusted
 * folder: at session start and before the first write. It copies the file's
 * bytes into the new place and reads them back, takes the old file out of its
 * place in one rename, checks that it still holds the bytes copied, and keeps
 * those bytes once more in the Namzu home
 * (`backups/projects/<folder>/namzu.config.local.json.backup.<ms>`) before the
 * old file goes. Anything in doubt keeps both files, which are then both read
 * (the new one over the old), and says so once.
 */

import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { slugForCwd } from '@namzu/sdk'

import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	sameSettings,
} from '../config/project-files.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { cliLogger } from '../logging.js'
import { readHintCount, writeHintCount } from '../tui/hint-counts.js'
import { type PermissionsConfig, type ToolPermission, isPermissionEffect } from './rules.js'

export { LEGACY_LOCAL_CONFIG_FILE, LOCAL_SETTINGS_FILE }

const NAMZU_DIRECTORY = '.namzu'
const SETTINGS_NAME = basename(LOCAL_SETTINGS_FILE)
/** The line the global ignore file gets; the star covers the lock and staging names. */
export const LOCAL_SETTINGS_IGNORE_LINE = `**/${LOCAL_SETTINGS_FILE}*`
/**
 * A lock nobody can vouch for (no process id, or one from another machine or
 * container) is taken over after this long: a write takes milliseconds.
 */
const LOCK_STALE_MS = 10_000
/**
 * A lock whose process is still running is taken over only after this long. A
 * holder can be paused (a sleeping laptop, a stopped process); past this, its
 * id was more likely reused by another program. A resumed holder still checks
 * the file before it replaces it.
 */
const LIVE_LOCK_STALE_MS = 10 * 60_000
/** How long a write waits for another Namzu saving the same folder's file. */
const LOCK_WAIT_MS = 2_000
/** A staging file this old, of a process that is gone, was never a saved answer. */
const STAGING_STALE_MS = 60 * 60 * 1000
const GIT_TIMEOUT_MS = 2_000
const PRIVATE_DIR_MODE = 0o700

/** The local settings file of the folder. */
export function localSettingsPath(cwd: string): string {
	return resolve(cwd, NAMZU_DIRECTORY, SETTINGS_NAME)
}

/** The local file's earlier place, at the top of the folder. */
export function legacyLocalConfigPath(cwd: string): string {
	return resolve(cwd, LEGACY_LOCAL_CONFIG_FILE)
}

function lockPath(cwd: string): string {
	return `${localSettingsPath(cwd)}.lock`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function errorCode(cause: unknown): string | undefined {
	return (cause as NodeJS.ErrnoException | null)?.code
}

function canonicalFolder(cwd: string): string {
	try {
		return realpathSync(resolve(cwd))
	} catch {
		return resolve(cwd)
	}
}

/**
 * Add allows to a `permissions` table, in place of nothing it already says:
 * a tool that is already allowed as a whole needs no pattern, a pattern that
 * is already there keeps its effect, and a tool with a whole-tool `ask` or
 * `deny` is left alone because a pattern added to it would turn that into
 * something else.
 */
export function addAllowRules(
	permissions: Readonly<Record<string, unknown>>,
	additions: PermissionsConfig,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...permissions }
	for (const [tool, wanted] of Object.entries(additions)) {
		const existing = out[tool]
		if (existing === undefined) {
			out[tool] = wanted
			continue
		}
		if (isPermissionEffect(existing)) continue
		if (!isRecord(existing)) continue
		if (isPermissionEffect(wanted)) {
			// A whole-tool allow on top of a table of patterns would reorder it;
			// it is only ever asked for an MCP tool, which has no patterns.
			continue
		}
		const table: Record<string, unknown> = { ...existing }
		for (const [pattern, effect] of Object.entries(wanted as Record<string, ToolPermission>)) {
			if (table[pattern] === undefined) table[pattern] = effect
		}
		out[tool] = table
	}
	return out
}

export interface LocalWrite {
	readonly path: string
	/** Set when nothing was written; the answer then holds for this session only. */
	readonly error?: string
	/** Set when the write was refused on purpose: a whole sentence to show as it is. */
	readonly sentence?: string
}

// ---------------------------------------------------------------------------
// the one writer
// ---------------------------------------------------------------------------

type NamzuDirectory = { readonly dir: string; readonly made: boolean } | { readonly error: string }

/** The folder's `.namzu` directory, made when missing; a link or a file there is refused. */
function namzuDirectory(cwd: string): NamzuDirectory {
	const dir = resolve(cwd, NAMZU_DIRECTORY)
	let made = false
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const info = lstatSync(dir)
			if (info.isSymbolicLink())
				return {
					error: `${NAMZU_DIRECTORY} in this folder is a link, so Namzu does not write its settings through it`,
				}
			if (!info.isDirectory())
				return {
					error: `${NAMZU_DIRECTORY} in this folder is a file, not a folder, so its settings have nowhere to go`,
				}
			return { dir, made }
		} catch (cause) {
			if (errorCode(cause) !== 'ENOENT') return { error: reason(cause) }
		}
		try {
			// Default mode: the folder also holds the project's shared, authored files.
			mkdirSync(dir)
			made = true
		} catch (cause) {
			if (errorCode(cause) !== 'EEXIST') return { error: reason(cause) }
		}
	}
	return { error: `${NAMZU_DIRECTORY} could not be made in this folder` }
}

/** A `.namzu` this call made and left empty goes again: a failed write leaves no trace. */
function removeIfEmpty(directory: NamzuDirectory): void {
	if (!('dir' in directory) || !directory.made) return
	try {
		rmdirSync(directory.dir)
	} catch {
		// Not empty (the write landed, or something else is in it now): it stays.
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (cause) {
		return errorCode(cause) === 'EPERM'
	}
}

/** Write every byte of `data`; a write that takes nothing is an error, not a loop. */
function writeAll(fd: number, data: Buffer): void {
	let offset = 0
	while (offset < data.length) {
		const written = writeSync(fd, data, offset, data.length - offset)
		if (!(written > 0)) throw new Error(`the disk took ${offset} of ${data.length} bytes`)
		offset += written
	}
}

/**
 * Whether a lock is left from a writer that is gone. One whose process id
 * names a process on this machine is judged by that process: gone, or this
 * process itself (which only takes the lock inside one synchronous call), is
 * left over; running is live, up to `LIVE_LOCK_STALE_MS`. One without an id,
 * or from another machine or container (where the id means nothing here), is
 * judged by its age alone.
 */
function lockIsStale(path: string): { readonly stale: boolean; readonly mtimeMs?: number } {
	let text: string
	let mtimeMs: number
	try {
		mtimeMs = statSync(path).mtimeMs
		text = readFileSync(path, 'utf8')
	} catch {
		return { stale: true }
	}
	let body: { pid?: unknown; host?: unknown } = {}
	try {
		const parsed: unknown = JSON.parse(text)
		if (isRecord(parsed)) body = parsed
	} catch {
		// Written halfway: judged by its age alone.
	}
	const age = Date.now() - mtimeMs
	const here = body.host === undefined || body.host === hostname()
	const pid = body.pid
	if (here && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
		if (pid === process.pid || !processAlive(pid)) return { stale: true, mtimeMs }
		return { stale: age > LIVE_LOCK_STALE_MS, mtimeMs }
	}
	return { stale: age > LOCK_STALE_MS, mtimeMs }
}

const BUSY = 'another Namzu is saving the settings of this folder right now'

/** Whether a lock's bytes name an owner other than `owner`; unreadable bytes name nobody. */
function namesAnotherOwner(
	bytes: Buffer | undefined,
	owner: { readonly pid: number; readonly at: string },
): boolean {
	if (bytes === undefined) return false
	try {
		const parsed: unknown = JSON.parse(bytes.toString('utf8'))
		return isRecord(parsed) && (parsed.pid !== owner.pid || parsed.at !== owner.at)
	} catch {
		return false
	}
}

type Lock = { readonly release: () => void } | { readonly refused: string; readonly busy: boolean }

/** Take the folder's lock, waiting up to `waitMs` for another writer. */
function takeLock(path: string, waitMs: number): Lock {
	const deadline = Date.now() + waitMs
	for (;;) {
		let fd: number | undefined
		try {
			fd = openSync(path, 'wx', 0o600)
		} catch (cause) {
			if (errorCode(cause) !== 'EEXIST')
				return { refused: `its lock could not be made (${reason(cause)})`, busy: false }
		}
		if (fd !== undefined) {
			const owner = { pid: process.pid, host: hostname(), at: new Date().toISOString() }
			const body = Buffer.from(JSON.stringify(owner))
			try {
				writeAll(fd, body)
			} catch (cause) {
				// A lock without its owner would be judged by age only: it goes now.
				try {
					closeSync(fd)
				} catch {
					// Closing is all that is left to try.
				}
				fd = undefined
				try {
					unlinkSync(path)
				} catch {
					// Already gone.
				}
				return { refused: `its lock could not be written (${reason(cause)})`, busy: false }
			} finally {
				if (fd !== undefined) closeSync(fd)
			}
			return {
				release: () => {
					// Not when it plainly names another writer: one taken over meanwhile is theirs.
					if (namesAnotherOwner(readBytes(path), owner)) return
					try {
						unlinkSync(path)
					} catch {
						// Already gone: a stale-lock sweep by another writer.
					}
				},
			}
		}
		const judged = lockIsStale(path)
		if (judged.stale) {
			// Removed only if it is still the lock that was judged, not a fresh one.
			let cleared = true
			try {
				if (judged.mtimeMs === undefined || statSync(path).mtimeMs === judged.mtimeMs)
					unlinkSync(path)
			} catch (cause) {
				// Gone already is fine; a lock that cannot be removed waits like a live one.
				cleared = errorCode(cause) === 'ENOENT'
			}
			if (cleared) continue
		}
		if (Date.now() >= deadline) return { refused: BUSY, busy: true }
		sleepSync(Math.min(25, Math.max(1, deadline - Date.now())))
	}
}

function readBytes(path: string): Buffer | undefined {
	try {
		return readFileSync(path)
	} catch {
		return undefined
	}
}

/**
 * Whether `path` still holds `before` (undefined: still absent). The check a
 * write makes just before it replaces the file, so a writer whose lock was
 * taken over while it was paused never puts its older view over a newer one.
 */
function stillHolds(path: string, before: Buffer | undefined): boolean {
	try {
		const info = lstatSync(path)
		if (before === undefined || info.isSymbolicLink() || !info.isFile()) return false
		return readFileSync(path).equals(before)
	} catch (cause) {
		return before === undefined && errorCode(cause) === 'ENOENT'
	}
}

function stagingPath(dir: string, name: string): string {
	return join(dir, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

/**
 * Write `data` to `target` through `staging`: created new with mode 0600,
 * every byte written, flushed, read back and compared, `guard` asked last,
 * then renamed over the target. Removed on any failure, so the target is never
 * replaced by anything but `data`. Returns the reason when nothing was replaced.
 */
function writeThroughStaging(
	staging: string,
	target: string,
	data: Buffer,
	guard: () => string | undefined,
): string | undefined {
	let fd: number | undefined
	try {
		fd = openSync(staging, 'wx', 0o600)
		writeAll(fd, data)
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		if (!readFileSync(staging).equals(data))
			throw new Error('the copy on disk is not what was written')
		const refused = guard()
		if (refused !== undefined) throw new Error(refused)
		renameSync(staging, target)
	} catch (cause) {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// Closing is all that is left to try.
			}
		}
		try {
			unlinkSync(staging)
		} catch {
			// Not made, or renamed already.
		}
		return reason(cause)
	}
	// The rename itself, flushed where the platform allows a folder to be opened.
	try {
		const folder = openSync(dirname(target), 'r')
		try {
			fsyncSync(folder)
		} finally {
			closeSync(folder)
		}
	} catch {
		// Windows cannot open a folder for this; the rename is still made.
	}
	return undefined
}

type ReadOutcome =
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'read'
			readonly bytes: Buffer
			readonly text: string
			readonly document: Record<string, unknown>
			/** Whether the bytes are UTF-8 text, so the text stands for them exactly. */
			readonly lossless: boolean
	  }
	| { readonly kind: 'refused'; readonly error: string }

function readSettingsFile(path: string, name: string): ReadOutcome {
	try {
		if (lstatSync(path).isSymbolicLink())
			return { kind: 'refused', error: `${name} is a link, so Namzu does not write through it` }
	} catch (cause) {
		if (errorCode(cause) === 'ENOENT') return { kind: 'absent' }
		return { kind: 'refused', error: reason(cause) }
	}
	let bytes: Buffer
	try {
		bytes = readFileSync(path)
	} catch (cause) {
		return { kind: 'refused', error: reason(cause) }
	}
	const text = bytes.toString('utf8')
	let parsed: unknown
	try {
		parsed = JSON.parse(text.replace(/^﻿/, ''))
	} catch (cause) {
		return { kind: 'refused', error: `${name} is not valid JSON (${reason(cause)})` }
	}
	if (!isRecord(parsed)) return { kind: 'refused', error: `${name} is not a JSON object` }
	const lossless = Buffer.from(text, 'utf8').equals(bytes)
	return { kind: 'read', bytes, text, document: parsed, lossless }
}

export type LocalChangeResult =
	| { readonly document: Record<string, unknown> }
	| { readonly unchanged: true }
	| { readonly error: string }

export interface LocalUpdateOptions {
	/** How long to wait for another Namzu saving the same folder's file. */
	readonly lockWaitMs?: number
	/** `legacy` changes the earlier `namzu.config.local.json`, for taking a rule out of it. */
	readonly target?: 'current' | 'legacy'
}

/**
 * Apply `change` to the folder's local settings under the lock, and write the
 * result. Synchronous and small: it runs on a keypress, and the file must be
 * on disk before the next turn starts.
 */
export function updateLocalSettings(
	cwd: string,
	change: (document: Record<string, unknown>) => LocalChangeResult,
	options: LocalUpdateOptions = {},
): LocalWrite {
	const legacy = options.target === 'legacy'
	const path = legacy ? legacyLocalConfigPath(cwd) : localSettingsPath(cwd)
	const name = legacy ? LEGACY_LOCAL_CONFIG_FILE : LOCAL_SETTINGS_FILE
	const folder = namzuDirectory(cwd)
	if ('error' in folder) return { path, error: folder.error }
	try {
		const lock = takeLock(lockPath(cwd), options.lockWaitMs ?? LOCK_WAIT_MS)
		if ('refused' in lock) return { path, error: lock.refused }
		try {
			const read = readSettingsFile(path, name)
			if (read.kind === 'refused') return { path, error: read.error }
			if (read.kind === 'absent' && legacy) return { path }
			if (read.kind === 'read' && !read.lossless)
				return {
					path,
					error: `${name} holds bytes that are not UTF-8 text, so Namzu does not rewrite it`,
				}
			const result = change(read.kind === 'read' ? read.document : {})
			if ('error' in result) return { path, error: result.error }
			if ('unchanged' in result) return { path }
			const data = Buffer.from(`${JSON.stringify(result.document, null, '\t')}\n`, 'utf8')
			const before = read.kind === 'read' ? read.bytes : undefined
			const failed = writeThroughStaging(stagingPath(folder.dir, SETTINGS_NAME), path, data, () =>
				stillHolds(path, before)
					? undefined
					: `${name} changed while this was being saved, so it was left as it is`,
			)
			if (failed !== undefined) return { path, error: failed }
			const back = readBytes(path)
			if (back === undefined) return { path, error: `${name} could not be read back` }
			if (!back.equals(data)) return { path, error: `${name} did not read back as written` }
			return { path }
		} finally {
			lock.release()
		}
	} finally {
		removeIfEmpty(folder)
	}
}

// ---------------------------------------------------------------------------
// what git says about a file
// ---------------------------------------------------------------------------

type Tracked = 'tracked' | 'untracked' | 'unknown'

/** Whether git tracks `name` (relative to `cwd`), asked synchronously, with a short limit. */
function gitTracks(cwd: string, name: string): Tracked {
	const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', name], {
		cwd,
		env: { ...process.env, LC_ALL: 'C' },
		encoding: 'utf8',
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	})
	if (result.error) return errorCode(result.error) === 'ENOENT' ? 'untracked' : 'unknown'
	if (result.status === 0) return 'tracked'
	if (result.status === 1) return 'untracked'
	return /not a git repository/i.test(result.stderr ?? '') ? 'untracked' : 'unknown'
}

/** Whether git tracks the folder's file `name` (either local settings name). */
export function gitTracksFile(cwd: string, name: string): boolean {
	return gitTracks(resolve(cwd), name) === 'tracked'
}

/** Folders whose local file git was found not to track, in this process. */
const untrackedFolders = new Set<string>()

/**
 * Whether git tracks the folder's `.namzu/settings.local.json`, which an answer
 * is then not written to. A "no" is remembered for the rest of the process; a
 * "yes" is never remembered, so taking the file out of git takes effect at the
 * next answer. `fresh` asks git again either way (`/permissions add`). A folder
 * without git, or a question git cannot answer, counts as not tracked.
 */
export function localSettingsTracked(
	cwd: string,
	options: { readonly fresh?: boolean } = {},
): boolean {
	const key = resolve(cwd)
	if (options.fresh !== true && untrackedFolders.has(key)) return false
	const tracked = gitTracks(key, LOCAL_SETTINGS_FILE) === 'tracked'
	if (tracked) untrackedFolders.delete(key)
	else untrackedFolders.add(key)
	return tracked
}

/** The sentence a refused write says when git tracks the local file. */
export const TRACKED_LOCAL_SETTINGS = `Git tracks ${LOCAL_SETTINGS_FILE}, so this was not saved there; it holds for this conversation only.`

// ---------------------------------------------------------------------------
// moving the earlier file
// ---------------------------------------------------------------------------

export type LocalMove =
	| { readonly state: 'nothing' }
	/** `backup`: where the old file's bytes are kept, in the Namzu home. */
	| { readonly state: 'moved'; readonly backup: string }
	| {
			readonly state: 'kept'
			readonly why:
				| 'tracked'
				| 'both'
				| 'unreadable'
				| 'link'
				| 'busy'
				| 'changed'
				| 'failed'
				| 'unknown'
			/** One sentence for the person. */
			readonly sentence: string
	  }

function kept(why: Extract<LocalMove, { state: 'kept' }>['why'], sentence: string): LocalMove {
	return { state: 'kept', why, sentence }
}

const STILL_READ = 'It stays where it is and is still read'
const TRY_AGAIN = 'Namzu tries again at the next start'

/** Where a moved folder's earlier local file is kept: in the Namzu home, never in the project. */
export function localSettingsBackupDir(cwd: string, home: string = resolveNamzuHome()): string {
	return join(home, 'backups', 'projects', slugForCwd(canonicalFolder(cwd)))
}

/** Keep `bytes` as `<home>/backups/projects/<folder>/namzu.config.local.json.backup.<ms>` (0600). */
function writeBackup(
	cwd: string,
	bytes: Buffer,
): { readonly path: string } | { readonly error: string } {
	try {
		const dir = localSettingsBackupDir(cwd)
		mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
		let stamp = Date.now()
		let path = join(dir, `${LEGACY_LOCAL_CONFIG_FILE}.backup.${stamp}`)
		while (exists(path)) {
			stamp += 1
			path = join(dir, `${LEGACY_LOCAL_CONFIG_FILE}.backup.${stamp}`)
		}
		const failed = writeThroughStaging(stagingPath(dir, basename(path)), path, bytes, () =>
			exists(path) ? 'a copy of that name appeared' : undefined,
		)
		if (failed !== undefined) return { error: failed }
		if (!readBytes(path)?.equals(bytes)) return { error: 'the copy did not read back as written' }
		return { path }
	} catch (cause) {
		return { error: reason(cause) }
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

/**
 * Put a file stepped aside back in its place, only when nothing new took that
 * place in the meantime. A hard link fails when the place is taken; where
 * links are not supported, a look and a rename do the same.
 */
function putBack(aside: string, place: string): boolean {
	let linked = false
	try {
		linkSync(aside, place)
		linked = true
	} catch (cause) {
		if (errorCode(cause) === 'EEXIST') return false
	}
	if (linked) {
		try {
			unlinkSync(aside)
		} catch {
			// Back in its place either way; the second name holds the same bytes and is not read.
		}
		return true
	}
	if (exists(place)) return false
	try {
		renameSync(aside, place)
		return true
	} catch {
		return false
	}
}

/** Remove the copy this move made, only while it still holds what was written. */
function dropCopy(path: string, bytes: Buffer): void {
	if (!readBytes(path)?.equals(bytes)) return
	try {
		unlinkSync(path)
	} catch {
		// Left: it holds the same bytes as the old file, so it is read once.
	}
}

/**
 * Move `namzu.config.local.json` to `.namzu/settings.local.json`. Call it only
 * for a trusted folder: an untrusted one's files are not read, and an archive
 * can carry one.
 *
 * The old file leaves its place only after its bytes were written to the new
 * place and read back equal, and only when git does not track it. It leaves in
 * one rename, so an older Namzu writing to it meanwhile makes a new file rather
 * than losing its change; the file stepped aside must still hold the bytes
 * copied, and those bytes are kept in the Namzu home before it is removed.
 * When the new file is already there with other settings, nothing moves: both
 * are read, the new one over the old.
 */
export function moveLegacyLocalConfig(
	cwd: string,
	options: { readonly lockWaitMs?: number } = {},
): LocalMove {
	const legacyPath = legacyLocalConfigPath(cwd)
	try {
		const info = lstatSync(legacyPath)
		if (info.isSymbolicLink())
			return kept(
				'link',
				`${LEGACY_LOCAL_CONFIG_FILE} is a link, so it was not moved. ${STILL_READ}.`,
			)
		if (!info.isFile())
			return kept('unreadable', `${LEGACY_LOCAL_CONFIG_FILE} is not a file, so it was not moved.`)
	} catch (cause) {
		if (errorCode(cause) === 'ENOENT') return { state: 'nothing' }
		return kept('unreadable', `${LEGACY_LOCAL_CONFIG_FILE} could not be read (${reason(cause)}).`)
	}
	const tracked = gitTracks(cwd, LEGACY_LOCAL_CONFIG_FILE)
	if (tracked === 'tracked')
		return kept(
			'tracked',
			`Git tracks ${LEGACY_LOCAL_CONFIG_FILE}, so it was not moved to ${LOCAL_SETTINGS_FILE}. ${STILL_READ}, and new answers go to ${LOCAL_SETTINGS_FILE}.`,
		)
	if (tracked === 'unknown')
		return kept(
			'unknown',
			`Git could not say whether it tracks ${LEGACY_LOCAL_CONFIG_FILE}, so it was not moved. ${STILL_READ}.`,
		)
	// Checked before anything is made in the folder: a file that cannot move leaves no trace.
	const first = readSettingsFile(legacyPath, LEGACY_LOCAL_CONFIG_FILE)
	if (first.kind === 'absent') return { state: 'nothing' }
	if (first.kind === 'refused')
		return kept('unreadable', `${first.error}, so it was not moved. ${STILL_READ}.`)
	const folder = namzuDirectory(cwd)
	if ('error' in folder)
		return kept(
			'failed',
			`${LEGACY_LOCAL_CONFIG_FILE} was not moved: ${folder.error}. ${STILL_READ}.`,
		)
	try {
		const lock = takeLock(lockPath(cwd), options.lockWaitMs ?? LOCK_WAIT_MS)
		if ('refused' in lock)
			return lock.busy
				? kept(
						'busy',
						`${LEGACY_LOCAL_CONFIG_FILE} was not moved, because another Namzu was saving this folder's settings. ${STILL_READ}.`,
					)
				: kept(
						'failed',
						`${LEGACY_LOCAL_CONFIG_FILE} was not moved: ${lock.refused}. ${STILL_READ}.`,
					)
		try {
			return moveUnderLock(cwd, folder.dir)
		} finally {
			lock.release()
		}
	} finally {
		removeIfEmpty(folder)
	}
}

function moveUnderLock(cwd: string, dir: string): LocalMove {
	const legacyPath = legacyLocalConfigPath(cwd)
	const currentPath = localSettingsPath(cwd)
	const legacy = readSettingsFile(legacyPath, LEGACY_LOCAL_CONFIG_FILE)
	if (legacy.kind === 'absent') return { state: 'nothing' }
	if (legacy.kind === 'refused')
		return kept('unreadable', `${legacy.error}, so it was not moved. ${STILL_READ}.`)
	const current = readSettingsFile(currentPath, LOCAL_SETTINGS_FILE)
	if (current.kind === 'refused')
		return kept(
			'unreadable',
			`${LEGACY_LOCAL_CONFIG_FILE} was not moved: ${current.error}. ${STILL_READ}.`,
		)
	if (current.kind === 'read') {
		if (!sameSettings(current.text, legacy.text))
			return kept(
				'both',
				`Both ${LEGACY_LOCAL_CONFIG_FILE} and ${LOCAL_SETTINGS_FILE} hold settings for this folder, so nothing was moved. Both are read, ${LOCAL_SETTINGS_FILE} over the other; move what you keep into it and delete ${LEGACY_LOCAL_CONFIG_FILE}.`,
			)
		// Compared as text, which stands for the bytes only when they are UTF-8.
		if (!legacy.lossless)
			return kept(
				'unreadable',
				`${LEGACY_LOCAL_CONFIG_FILE} holds bytes that are not UTF-8 text, so it was not compared with ${LOCAL_SETTINGS_FILE} or removed. ${STILL_READ}.`,
			)
	}
	let copied = false
	if (current.kind === 'absent') {
		const failed = writeThroughStaging(
			stagingPath(dir, SETTINGS_NAME),
			currentPath,
			legacy.bytes,
			() =>
				stillHolds(currentPath, undefined)
					? undefined
					: `${LOCAL_SETTINGS_FILE} appeared while it was being written`,
		)
		if (failed !== undefined)
			return kept('failed', `${LEGACY_LOCAL_CONFIG_FILE} was not moved (${failed}). ${STILL_READ}.`)
		if (!readBytes(currentPath)?.equals(legacy.bytes))
			// Someone wrote the new file just now; it is theirs, and the old file stays.
			return kept(
				'changed',
				`${LOCAL_SETTINGS_FILE} changed while ${LEGACY_LOCAL_CONFIG_FILE} was being moved, so the old file was kept. ${STILL_READ}.`,
			)
		copied = true
	}
	// Out of its place in one step: an older Namzu writing to it now makes a new
	// file, which stays, instead of having its change removed with the old one.
	// Stepped into `.namzu` under the local file's name, so git ignores it there too.
	const aside = join(
		dir,
		`${SETTINGS_NAME}.moving.${process.pid}.${randomBytes(4).toString('hex')}`,
	)
	const asideName = `${NAMZU_DIRECTORY}/${basename(aside)}`
	try {
		renameSync(legacyPath, aside)
	} catch (cause) {
		if (copied) dropCopy(currentPath, legacy.bytes)
		return errorCode(cause) === 'ENOENT'
			? kept(
					'changed',
					`${LEGACY_LOCAL_CONFIG_FILE} changed while it was being moved, so nothing was moved. ${TRY_AGAIN}.`,
				)
			: kept(
					'failed',
					`${LEGACY_LOCAL_CONFIG_FILE} was not moved (${reason(cause)}). ${STILL_READ}.`,
				)
	}
	if (!readBytes(aside)?.equals(legacy.bytes)) {
		// Written between the read and the step aside: it goes back, and the copy, now stale, goes.
		const back = putBack(aside, legacyPath)
		if (copied) dropCopy(currentPath, legacy.bytes)
		return back
			? kept(
					'changed',
					`${LEGACY_LOCAL_CONFIG_FILE} changed while it was being moved, so it was kept. ${STILL_READ}; ${TRY_AGAIN.toLowerCase()}.`,
				)
			: kept(
					'changed',
					`${LEGACY_LOCAL_CONFIG_FILE} changed twice while it was being moved. The newer version is in its place and still read; the one before it is kept as ${asideName}.`,
				)
	}
	const backup = writeBackup(cwd, legacy.bytes)
	if ('error' in backup) {
		const back = putBack(aside, legacyPath)
		return kept(
			'failed',
			back
				? `${LEGACY_LOCAL_CONFIG_FILE} holds the same settings as ${LOCAL_SETTINGS_FILE} now, but its backup could not be written (${backup.error}), so it stays where it is too. The two are read once; ${TRY_AGAIN.toLowerCase()}.`
				: `${LEGACY_LOCAL_CONFIG_FILE} holds the same settings as ${LOCAL_SETTINGS_FILE} now, but its backup could not be written (${backup.error}). The old file is kept as ${asideName}.`,
		)
	}
	try {
		unlinkSync(aside)
	} catch (cause) {
		return kept(
			'failed',
			`${LEGACY_LOCAL_CONFIG_FILE} was moved to ${LOCAL_SETTINGS_FILE} and kept in ${backup.path}, but ${asideName} could not be removed (${reason(cause)}). It is not read; delete it when you can.`,
		)
	}
	cliLogger().info('The local settings file moved into .namzu', {
		'namzu.settings.local.backup': backup.path,
	})
	return { state: 'moved', backup: backup.path }
}

const movedFolders = new Set<string>()

/** `moveLegacyLocalConfig` once per folder and process: before the first write. */
export function moveLegacyLocalConfigOnce(cwd: string): LocalMove | undefined {
	const key = resolve(cwd)
	if (movedFolders.has(key)) return undefined
	movedFolders.add(key)
	return moveLegacyLocalConfig(key)
}

/**
 * Remove staging files an earlier writer left: its process is gone, the file
 * is over an hour old, and the settings file it was meant for reads as JSON.
 * Such a file was never a saved answer (the session said it held for that
 * session only, or the process died before it said anything).
 */
export function removeStaleStagingFiles(cwd: string): number {
	const live = [localSettingsPath(cwd), legacyLocalConfigPath(cwd)].some((path) => {
		try {
			JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
			return true
		} catch {
			return false
		}
	})
	if (!live) return 0
	let removed = 0
	for (const [dir, pattern] of [
		[resolve(cwd), /^namzu\.config\.local\.json\.(\d+)\.tmp$/],
		[resolve(cwd, NAMZU_DIRECTORY), /^settings\.local\.json\.(\d+)\.[0-9a-f]+\.tmp$/],
	] as const) {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			continue
		}
		for (const name of names) {
			const match = pattern.exec(name)
			if (!match) continue
			const pid = Number(match[1])
			if (pid === process.pid || processAlive(pid)) continue
			const path = join(dir, name)
			try {
				const info = lstatSync(path)
				if (!info.isFile() || Date.now() - info.mtimeMs < STAGING_STALE_MS) continue
				unlinkSync(path)
				removed += 1
			} catch {
				// Gone, or not ours to remove.
			}
		}
	}
	return removed
}

/**
 * `sentence`, unless it was said already for this folder and this state. The
 * record is a count in `hint-counts.json` in the Namzu home, keyed by a hash of
 * the folder, the kind and what the state is made of, so a changed state is
 * said again. A record that cannot be read or written says it again.
 */
function sayOnce(cwd: string, kind: string, state: Buffer | string, sentence: string): string[] {
	const key = `localSettings.${createHash('sha256')
		.update(canonicalFolder(cwd))
		.update('\0')
		.update(kind)
		.update('\0')
		.update(state)
		.digest('hex')
		.slice(0, 24)}`
	if (readHintCount(key) > 0) return []
	writeHintCount(key, 1)
	return [sentence]
}

/** The sentence a session start says when git may take the local file along, or none. */
export function ignoreSentence(outcome: IgnoreOutcome): string | undefined {
	switch (outcome.state) {
		case 'ignored':
		case 'not-a-repository':
			return undefined
		case 'tracked':
			return `Git tracks ${LOCAL_SETTINGS_FILE}, so its settings are part of the repository and new answers are not saved to it. To keep it on this computer only, run git rm --cached ${LOCAL_SETTINGS_FILE}.`
		case 'not-read':
			return `Git does not ignore ${LOCAL_SETTINGS_FILE} although ${LOCAL_SETTINGS_IGNORE_LINE} is in its global ignore file; a rule in this repository may let it through. Adding .namzu to git would take the file along.`
		case 'failed':
			return `Namzu could not make git ignore ${LOCAL_SETTINGS_FILE} (${outcome.reason}), so adding .namzu to git would take it along. Add ${LOCAL_SETTINGS_IGNORE_LINE} to your global git ignore file.`
	}
}

export interface SettledLocalSettings {
	/** What to say at the start of the session: at most one sentence, each said once. */
	readonly said: readonly string[]
	/** What git ignoring the file comes to, said once; never rejects. */
	readonly ignore: Promise<readonly string[]>
}

/**
 * What a session start does for a trusted folder: move the earlier file, clear
 * stale staging files, and make sure git ignores the local file when one is
 * there. A sentence about a state is said once, until the state changes.
 */
export function settleLocalSettings(cwd: string): SettledLocalSettings {
	const key = resolve(cwd)
	movedFolders.add(key)
	const move = moveLegacyLocalConfig(key)
	removeStaleStagingFiles(key)
	let ignore: Promise<readonly string[]> = Promise.resolve([])
	try {
		if (lstatSync(localSettingsPath(key)).isFile())
			ignore = ensureLocalConfigIgnored(key)
				.then((outcome) => {
					logIgnoreOutcome(outcome)
					const sentence = ignoreSentence(outcome)
					return sentence === undefined ? [] : sayOnce(key, 'ignore', outcome.state, sentence)
				})
				.catch(() => [])
	} catch {
		// No local file: nothing for git to ignore.
	}
	const said =
		move.state === 'kept'
			? sayOnce(
					key,
					`kept:${move.why}`,
					readBytes(legacyLocalConfigPath(key)) ?? Buffer.alloc(0),
					move.sentence,
				)
			: []
	return { said, ignore }
}

/**
 * Merge `additions` into the project's local settings, moving the earlier file
 * first. Refused, with a sentence, when git tracks the local file.
 */
export function writeLocalAllows(
	cwd: string,
	additions: PermissionsConfig,
	options: LocalUpdateOptions = {},
): LocalWrite {
	moveLegacyLocalConfigOnce(cwd)
	if (localSettingsTracked(cwd))
		return { path: localSettingsPath(cwd), sentence: TRACKED_LOCAL_SETTINGS }
	return updateLocalSettings(
		cwd,
		(document) => {
			if (document.permissions !== undefined && !isRecord(document.permissions))
				return { error: `${LOCAL_SETTINGS_FILE} has a permissions value that is not a table` }
			const permissions = isRecord(document.permissions) ? document.permissions : {}
			return { document: { ...document, permissions: addAllowRules(permissions, additions) } }
		},
		options,
	)
}

// ---------------------------------------------------------------------------
// keeping git from tracking the file
// ---------------------------------------------------------------------------

function git(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
	return new Promise((done) => {
		execFile(
			'git',
			[...args],
			{ cwd, env, timeout: 15_000, windowsHide: true },
			(error, stdout) => {
				const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
				done({ code, stdout: String(stdout ?? '') })
			},
		)
	})
}

/** The global ignore file git reads: `core.excludesFile`, else the XDG default. */
function globalIgnorePath(configured: string, env: NodeJS.ProcessEnv): string {
	const home = env.HOME ?? env.USERPROFILE ?? homedir()
	const value = configured.trim()
	if (value === '~' || value.startsWith('~/')) return join(home, value.slice(2))
	if (value !== '' && isAbsolute(value)) return value
	const xdg = env.XDG_CONFIG_HOME
	if (xdg && isAbsolute(xdg)) return join(xdg, 'git', 'ignore')
	return join(home, '.config', 'git', 'ignore')
}

export type IgnoreOutcome =
	| { readonly state: 'ignored'; readonly written: boolean }
	| { readonly state: 'not-a-repository' }
	| { readonly state: 'tracked' | 'not-read' | 'failed'; readonly reason: string }

/**
 * Make git ignore the local settings file in every repository: one line in the
 * global ignore file, only when the folder is in a git work tree and git does
 * not ignore the file already. Never throws; the answer was remembered either
 * way.
 */
export async function ensureLocalConfigIgnored(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<IgnoreOutcome> {
	try {
		const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd, env)
		if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { state: 'not-a-repository' }
		const ignored = async () =>
			(await git(['check-ignore', '--', LOCAL_SETTINGS_FILE], cwd, env)).code === 0
		if (await ignored()) return { state: 'ignored', written: false }

		const configured = await git(['config', '--global', '--get', 'core.excludesfile'], cwd, env)
		const file = globalIgnorePath(configured.code === 0 ? configured.stdout : '', env)
		const line = LOCAL_SETTINGS_IGNORE_LINE
		await mkdir(dirname(file), { recursive: true })
		let existing = ''
		try {
			existing = await readFile(file, 'utf-8')
		} catch {
			// Not there yet: it is created below.
		}
		const why = async (): Promise<'tracked' | 'not-read'> =>
			(await git(['ls-files', '--error-unmatch', '--', LOCAL_SETTINGS_FILE], cwd, env)).code === 0
				? 'tracked'
				: 'not-read'
		if (existing.split(/\r?\n/).includes(line)) {
			const state = await why()
			return { state, reason: `${line} is in ${file} but git does not ignore the file` }
		}
		if (existing === '') await writeFile(file, `${line}\n`, 'utf-8')
		else await appendFile(file, `${existing.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf-8')
		if (!(await ignored())) {
			const state = await why()
			return { state, reason: `wrote ${line} to ${file} but git still does not ignore it` }
		}
		return { state: 'ignored', written: true }
	} catch (cause) {
		return { state: 'failed', reason: reason(cause) }
	}
}

/** Say what `ensureLocalConfigIgnored` found, where it is worth saying. */
export function logIgnoreOutcome(outcome: IgnoreOutcome): void {
	if (outcome.state === 'ignored' || outcome.state === 'not-a-repository') return
	cliLogger().warn('The local settings file may be tracked by git', {
		'namzu.settings.local.state': outcome.state,
		'namzu.settings.local.reason': outcome.reason,
	})
}
