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
 * the file, re-reads the file under it, applies the change, writes a staging
 * file in `.namzu` (mode 0600), flushes it to disk, renames it over the file,
 * and reads the result back. A file that is not valid JSON is left alone and the
 * answer holds for the session only. A `.namzu` that is a link or a file is
 * refused, and so is a settings file that is a link.
 *
 * `namzu.config.local.json` at the top of the folder is where an earlier Namzu
 * wrote these answers. `moveLegacyLocalConfig` moves it once, in a trusted
 * folder: at session start and before the first write. It copies the file's
 * bytes into the new place, reads them back, and only then removes the old
 * file, and only when git does not track it. Anything in doubt keeps both
 * files, which are then both read (the new one over the old), and says so.
 */

import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	sameSettings,
} from '../config/project-files.js'
import { cliLogger } from '../logging.js'
import { type PermissionsConfig, type ToolPermission, isPermissionEffect } from './rules.js'

export { LEGACY_LOCAL_CONFIG_FILE, LOCAL_SETTINGS_FILE }

const NAMZU_DIRECTORY = '.namzu'
const SETTINGS_NAME = basename(LOCAL_SETTINGS_FILE)
/** The line the global ignore file gets; the star covers the lock and staging names. */
export const LOCAL_SETTINGS_IGNORE_LINE = `**/${LOCAL_SETTINGS_FILE}*`
/** A lock older than this is a crashed writer's: a write takes milliseconds. */
const LOCK_STALE_MS = 10_000
/** How long a write waits for another Namzu saving the same folder's file. */
const LOCK_WAIT_MS = 2_000
/** A staging file this old, of a process that is gone, was never a saved answer. */
const STAGING_STALE_MS = 60 * 60 * 1000
const GIT_TIMEOUT_MS = 2_000

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

/** The folder's `.namzu` directory, made when asked to; a link or a file there is refused. */
function namzuDirectory(cwd: string): { readonly dir: string } | { readonly error: string } {
	const dir = resolve(cwd, NAMZU_DIRECTORY)
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
			return { dir }
		} catch (cause) {
			if (errorCode(cause) !== 'ENOENT') return { error: reason(cause) }
		}
		try {
			// Default mode: the folder also holds the project's shared, authored files.
			mkdirSync(dir)
		} catch (cause) {
			if (errorCode(cause) !== 'EEXIST') return { error: reason(cause) }
		}
	}
	return { error: `${NAMZU_DIRECTORY} could not be made in this folder` }
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

/**
 * Whether a lock is left from a writer that is gone: its process is not
 * running, or it is older than any write takes. One held under this process's
 * own id is left over too, since this process only takes the lock inside one
 * synchronous call.
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
	let pid: unknown
	try {
		pid = (JSON.parse(text) as { pid?: unknown }).pid
	} catch {
		// Written halfway: judged by its age alone.
	}
	if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
		if (pid === process.pid || !processAlive(pid)) return { stale: true, mtimeMs }
	}
	return { stale: Date.now() - mtimeMs > LOCK_STALE_MS, mtimeMs }
}

/** Take the folder's lock, waiting up to `waitMs` for another writer. Undefined: not taken. */
function takeLock(path: string, waitMs: number): (() => void) | undefined {
	const deadline = Date.now() + waitMs
	for (;;) {
		try {
			const fd = openSync(path, 'wx', 0o600)
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
			} finally {
				closeSync(fd)
			}
			return () => {
				try {
					unlinkSync(path)
				} catch {
					// Already gone: a stale-lock sweep by another writer.
				}
			}
		} catch (cause) {
			if (errorCode(cause) !== 'EEXIST') return undefined
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
		if (Date.now() >= deadline) return undefined
		sleepSync(Math.min(25, Math.max(1, deadline - Date.now())))
	}
}

/**
 * Write `text` to `target` through a staging file in `dir`: created new with
 * mode 0600, flushed, renamed over the target, and removed on any failure.
 */
function writeThroughStaging(dir: string, target: string, text: string): string | undefined {
	const staging = join(dir, `${SETTINGS_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
	let fd: number | undefined
	try {
		fd = openSync(staging, 'wx', 0o600)
		writeSync(fd, text)
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
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
		const folder = openSync(dir, 'r')
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
	| { readonly kind: 'read'; readonly text: string; readonly document: Record<string, unknown> }
	| { readonly kind: 'refused'; readonly error: string }

function readSettingsFile(path: string, name: string): ReadOutcome {
	try {
		if (lstatSync(path).isSymbolicLink())
			return { kind: 'refused', error: `${name} is a link, so Namzu does not write through it` }
	} catch (cause) {
		if (errorCode(cause) === 'ENOENT') return { kind: 'absent' }
		return { kind: 'refused', error: reason(cause) }
	}
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (cause) {
		return { kind: 'refused', error: reason(cause) }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text.replace(/^﻿/, ''))
	} catch (cause) {
		return { kind: 'refused', error: `${name} is not valid JSON (${reason(cause)})` }
	}
	if (!isRecord(parsed)) return { kind: 'refused', error: `${name} is not a JSON object` }
	return { kind: 'read', text, document: parsed }
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
	const release = takeLock(lockPath(cwd), options.lockWaitMs ?? LOCK_WAIT_MS)
	if (!release)
		return { path, error: 'another Namzu is saving the settings of this folder right now' }
	try {
		const read = readSettingsFile(path, name)
		if (read.kind === 'refused') return { path, error: read.error }
		if (read.kind === 'absent' && legacy) return { path }
		const result = change(read.kind === 'read' ? read.document : {})
		if ('error' in result) return { path, error: result.error }
		if ('unchanged' in result) return { path }
		const text = `${JSON.stringify(result.document, null, '\t')}\n`
		const failed = writeThroughStaging(folder.dir, path, text)
		if (failed !== undefined) return { path, error: failed }
		let back: string
		try {
			back = readFileSync(path, 'utf8')
		} catch (cause) {
			return { path, error: `${name} could not be read back (${reason(cause)})` }
		}
		if (back !== text) return { path, error: `${name} did not read back as written` }
		return { path }
	} finally {
		release()
	}
}

// ---------------------------------------------------------------------------
// what git says about a file
// ---------------------------------------------------------------------------

type Tracked = 'tracked' | 'untracked' | 'unknown'

/** Whether git tracks `name` (relative to `cwd`), asked once, synchronously, with a short limit. */
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

const trackedLocalSettings = new Map<string, boolean>()

/**
 * Whether git tracks the folder's `.namzu/settings.local.json`, which an answer
 * is then not written to. Asked once per folder and process; a folder without
 * git, or a question git cannot answer, counts as not tracked.
 */
export function localSettingsTracked(cwd: string): boolean {
	const key = resolve(cwd)
	const known = trackedLocalSettings.get(key)
	if (known !== undefined) return known
	const tracked = gitTracks(key, LOCAL_SETTINGS_FILE) === 'tracked'
	trackedLocalSettings.set(key, tracked)
	return tracked
}

/** The sentence a refused write says when git tracks the local file. */
export const TRACKED_LOCAL_SETTINGS = `Git tracks ${LOCAL_SETTINGS_FILE}, so this was not saved there; it holds for this conversation only.`

// ---------------------------------------------------------------------------
// moving the earlier file
// ---------------------------------------------------------------------------

export type LocalMove =
	| { readonly state: 'nothing' }
	| { readonly state: 'moved' }
	| {
			readonly state: 'kept'
			readonly why: 'tracked' | 'both' | 'unreadable' | 'link' | 'busy' | 'failed' | 'unknown'
			/** One sentence for the person. */
			readonly sentence: string
	  }

function kept(why: Extract<LocalMove, { state: 'kept' }>['why'], sentence: string): LocalMove {
	return { state: 'kept', why, sentence }
}

const STILL_READ = 'It stays where it is and is still read'

/**
 * Move `namzu.config.local.json` to `.namzu/settings.local.json`. Call it only
 * for a trusted folder: an untrusted one's files are not read, and an archive
 * can carry one.
 *
 * The old file is removed only after its bytes were written to the new place,
 * read back equal, and found unchanged since, and only when git does not track
 * it. When the new file is already there with other settings, nothing moves:
 * both are read, the new one over the old.
 */
export function moveLegacyLocalConfig(
	cwd: string,
	options: { readonly lockWaitMs?: number } = {},
): LocalMove {
	const legacyPath = legacyLocalConfigPath(cwd)
	const currentPath = localSettingsPath(cwd)
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
	const folder = namzuDirectory(cwd)
	if ('error' in folder)
		return kept(
			'failed',
			`${LEGACY_LOCAL_CONFIG_FILE} was not moved: ${folder.error}. ${STILL_READ}.`,
		)
	const release = takeLock(lockPath(cwd), options.lockWaitMs ?? LOCK_WAIT_MS)
	if (!release)
		return kept(
			'busy',
			`${LEGACY_LOCAL_CONFIG_FILE} was not moved, because another Namzu was saving this folder's settings. ${STILL_READ}.`,
		)
	try {
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
		if (current.kind === 'read' && !sameSettings(current.text, legacy.text))
			return kept(
				'both',
				`Both ${LEGACY_LOCAL_CONFIG_FILE} and ${LOCAL_SETTINGS_FILE} hold settings for this folder, so nothing was moved. Both are read, ${LOCAL_SETTINGS_FILE} over the other; move what you keep into it and delete ${LEGACY_LOCAL_CONFIG_FILE}.`,
			)
		if (current.kind === 'absent') {
			const failed = writeThroughStaging(folder.dir, currentPath, legacy.text)
			if (failed !== undefined)
				return kept(
					'failed',
					`${LEGACY_LOCAL_CONFIG_FILE} was not moved (${failed}). ${STILL_READ}.`,
				)
			let back: string | undefined
			try {
				back = readFileSync(currentPath, 'utf8')
			} catch {
				back = undefined
			}
			if (back !== legacy.text) {
				// The copy is not what the old file holds: it goes, and the old file stays.
				try {
					unlinkSync(currentPath)
				} catch {
					// Left behind; it differs, so both are read and the next start says so.
				}
				return kept(
					'failed',
					`${LEGACY_LOCAL_CONFIG_FILE} was not moved, because its copy did not read back the same. ${STILL_READ}.`,
				)
			}
		}
		// The old file must still hold what was copied: an older Namzu may be writing to it.
		let now: string | undefined
		try {
			now = readFileSync(legacyPath, 'utf8')
		} catch {
			now = undefined
		}
		if (now !== legacy.text)
			return kept(
				'both',
				`${LEGACY_LOCAL_CONFIG_FILE} changed while it was being moved, so it was kept. Both files are read, ${LOCAL_SETTINGS_FILE} over the other.`,
			)
		try {
			unlinkSync(legacyPath)
		} catch (cause) {
			return kept(
				'failed',
				`${LEGACY_LOCAL_CONFIG_FILE} was copied to ${LOCAL_SETTINGS_FILE} but could not be removed (${reason(cause)}). It is no longer read; delete it when you can.`,
			)
		}
		return { state: 'moved' }
	} finally {
		release()
	}
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
 * What a session start does for a trusted folder: move the earlier file, clear
 * stale staging files, and make sure git ignores the local file when one is
 * there. Returns the sentences worth saying, at most one.
 */
export function settleLocalSettings(cwd: string): string[] {
	const key = resolve(cwd)
	movedFolders.add(key)
	const move = moveLegacyLocalConfig(key)
	removeStaleStagingFiles(key)
	try {
		if (lstatSync(localSettingsPath(key)).isFile())
			void ensureLocalConfigIgnored(key).then(logIgnoreOutcome)
	} catch {
		// No local file: nothing for git to ignore.
	}
	return move.state === 'kept' ? [move.sentence] : []
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
