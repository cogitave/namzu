import { readFileSync, writeFileSync } from 'node:fs'
import {
	chmod,
	lstat,
	readFile,
	readdir,
	readlink,
	rm,
	rmdir,
	stat,
	unlink,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isEntityId } from './id.js'
import { privateTempRootPath } from './temp.js'

/**
 * Clearing what sessions left in Namzu's private temporary folder
 * (`<temp base>/namzu-<user>`, see `temp.ts`).
 *
 * Nothing removed a session's scratch folder when the session ended, and the
 * operating system does not always clear its temporary folder: on a machine
 * that is never restarted, or where `/tmp` is a plain folder on the main disk,
 * the folders stay until the disk is full. This sweep removes three kinds of
 * leftovers, and nothing else in the folder:
 *
 * - `<slug>/<session-id>/` folders (the scratch folder and its `jobs/`) in
 *   which nothing has changed for {@link TEMP_SWEEP_MAX_AGE_MS}, unless the
 *   caller says the session is running. The age is the newest change of
 *   anything inside, not the folder's own time: one folder is shared by every
 *   home on the machine, so a session of another home that this process
 *   cannot ask about is protected by its own recent writes.
 * - `hook-env*` folders whose owner process has exited. A folder made before
 *   owners were recorded is removed once nothing in it changed for the same age.
 * - `s-<hex>` short names whose folder is gone.
 *
 * A link is never followed, an entry of another user is never touched, and a
 * folder too large to read in full counts as recent. Errors are counted and
 * left: this is housekeeping, and it never stops a session from starting.
 */

/** A scratch folder in which nothing changed for this long belongs to no running session. */
export const TEMP_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** The sweep runs at most this often; the stamp file records when it last did. */
export const TEMP_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000
/** The stamp file in the private folder. */
export const TEMP_SWEEP_STAMP = '.last-cleanup'
/** The file a hook-env folder's owner writes into it (`session-hook-env.ts`). */
export const HOOK_ENV_OWNER_FILE = 'owner.json'
/** The most entries read inside one folder to learn its age; a larger folder counts as recent. */
const MAX_ENTRIES_PER_FOLDER = 5000
const ALIAS = /^s-[0-9a-f]{8}$/
const HOOK_ENV = /^hook-env/

export interface TempSweepOptions {
	/** The private folder. Default {@link privateTempRootPath}. */
	readonly root?: string
	/** Default `Date.now()`. */
	readonly now?: number
	/** Default {@link TEMP_SWEEP_MAX_AGE_MS}. */
	readonly maxAgeMs?: number
	/** Default {@link TEMP_SWEEP_EVERY_MS}; 0 runs every time. */
	readonly everyMs?: number
	/** Session ids never to touch: the ones this process runs. */
	readonly keep?: ReadonlySet<string>
	/** Whether a session is running (its writer lease is live). A throw counts as running. */
	readonly isSessionLive?: (slug: string, sessionId: string) => boolean | Promise<boolean>
	/** Default `process.kill(pid, 0)`. */
	readonly isPidAlive?: (pid: number) => boolean
	/** Default `process.getuid`; `undefined` skips the owner check (win32). */
	readonly getuid?: (() => number) | undefined
}

export interface TempSweepReport {
	/** False when the sweep was not due (or the folder does not exist). */
	readonly ran: boolean
	readonly removedSessions: number
	readonly removedHookEnv: number
	readonly removedAliases: number
	/** Folders it could not remove, or could not read in full. */
	readonly failed: number
}

const NOT_RUN: TempSweepReport = {
	ran: false,
	removedSessions: 0,
	removedHookEnv: 0,
	removedAliases: 0,
	failed: 0,
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: the process exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * The newest change inside `dir` (its own time included), walking real folders
 * only. `undefined` when the folder holds more than the bound: it is then
 * treated as recent, so a folder that cannot be read in full is never removed.
 */
async function newestChange(dir: string): Promise<number | undefined> {
	let newest = 0
	let seen = 0
	const pending = [dir]
	while (pending.length > 0) {
		const current = pending.pop() as string
		const entry = await lstat(current)
		newest = Math.max(newest, entry.mtimeMs, entry.ctimeMs)
		if (!entry.isDirectory()) continue
		const names = await readdir(current)
		seen += names.length
		if (seen > MAX_ENTRIES_PER_FOLDER) return undefined
		for (const name of names) pending.push(join(current, name))
	}
	return newest
}

function ownedBy(entry: { uid: number }, getuid: (() => number) | undefined): boolean {
	return getuid === undefined || entry.uid === getuid()
}

/** Make a folder writable again before removing it: a test or a tool may leave read-only folders. */
async function removeTree(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true })
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code !== 'EACCES' && code !== 'EPERM') throw error
		const pending = [path]
		while (pending.length > 0) {
			const current = pending.pop() as string
			const entry = await lstat(current).catch(() => undefined)
			if (!entry?.isDirectory()) continue
			await chmod(current, 0o700).catch(() => undefined)
			for (const name of await readdir(current).catch(() => [] as string[]))
				pending.push(join(current, name))
		}
		await rm(path, { recursive: true, force: true })
	}
}

/** Whether the stamp says the sweep ran within `everyMs`; writes a new stamp when it is due. */
function claimDue(root: string, now: number, everyMs: number): boolean {
	if (everyMs <= 0) return true
	const stamp = join(root, TEMP_SWEEP_STAMP)
	try {
		const last = Date.parse(readFileSync(stamp, 'utf8').trim())
		if (Number.isFinite(last) && last <= now && now - last < everyMs) return false
	} catch {
		// No stamp yet, or one that cannot be read: the sweep is due.
	}
	try {
		writeFileSync(stamp, `${new Date(now).toISOString()}\n`, { mode: 0o600 })
	} catch {
		// A stamp that cannot be written means the next start sweeps again; that is all.
	}
	return true
}

/** A hook-env folder whose owner reads as dead is removed only once nothing in it changed for this long. */
const HOOK_ENV_IDLE_MS = 10 * 60 * 1000

/** The owner a hook-env folder recorded, if it recorded one. */
async function hookEnvOwner(dir: string): Promise<number | undefined> {
	try {
		const raw = JSON.parse(await readFile(join(dir, HOOK_ENV_OWNER_FILE), 'utf8')) as {
			pid?: unknown
		}
		return typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) && raw.pid > 0
			? raw.pid
			: undefined
	} catch {
		return undefined
	}
}

/**
 * Remove old session scratch folders, hook-env folders of exited processes and
 * short names that point nowhere, in Namzu's private temporary folder. See the
 * module header for exactly what is and is not removed.
 */
export async function sweepPrivateTempRoot(
	options: TempSweepOptions = {},
): Promise<TempSweepReport> {
	const root = resolve(options.root ?? privateTempRootPath())
	if (!isAbsolute(root)) return NOT_RUN
	const now = options.now ?? Date.now()
	const maxAgeMs = options.maxAgeMs ?? TEMP_SWEEP_MAX_AGE_MS
	const getuid = 'getuid' in options ? options.getuid : process.getuid?.bind(process)
	const isPidAlive = options.isPidAlive ?? defaultPidAlive
	const keep = options.keep ?? new Set<string>()
	try {
		const top = await lstat(root)
		if (!top.isDirectory() || top.isSymbolicLink() || !ownedBy(top, getuid)) return NOT_RUN
	} catch {
		return NOT_RUN
	}
	if (!claimDue(root, now, options.everyMs ?? TEMP_SWEEP_EVERY_MS)) return NOT_RUN

	let removedSessions = 0
	let removedHookEnv = 0
	let removedAliases = 0
	let failed = 0
	const old = async (dir: string): Promise<boolean> => {
		try {
			const newest = await newestChange(dir)
			if (newest === undefined) {
				failed += 1
				return false
			}
			return now - newest >= maxAgeMs
		} catch {
			failed += 1
			return false
		}
	}
	const idleFor = async (dir: string, ms: number): Promise<boolean> => {
		try {
			const newest = await newestChange(dir)
			return newest !== undefined && now - newest >= ms
		} catch {
			return false
		}
	}
	const running = async (slug: string, sessionId: string): Promise<boolean> => {
		if (keep.has(sessionId)) return true
		if (!options.isSessionLive) return false
		try {
			return await options.isSessionLive(slug, sessionId)
		} catch {
			return true
		}
	}

	let names: string[]
	try {
		names = await readdir(root)
	} catch {
		return { ...NOT_RUN, ran: true, failed: 1 }
	}
	for (const name of names) {
		if (ALIAS.test(name)) continue // after the folders, so a link to one removed now goes too
		const path = join(root, name)
		let entry: Awaited<ReturnType<typeof lstat>>
		try {
			entry = await lstat(path)
		} catch {
			continue
		}
		if (!entry.isDirectory() || entry.isSymbolicLink() || !ownedBy(entry, getuid)) continue
		if (HOOK_ENV.test(name)) {
			const pid = await hookEnvOwner(path)
			// A pid this process cannot see (another pid namespace sharing the folder) reads as dead, so
			// a dead owner alone is not enough: the folder must also have been idle for a while.
			const gone =
				pid === undefined
					? await old(path)
					: !isPidAlive(pid) && (await idleFor(path, HOOK_ENV_IDLE_MS))
			if (!gone) continue
			try {
				await removeTree(path)
				removedHookEnv += 1
			} catch {
				failed += 1
			}
			continue
		}
		// A project's folder holds one folder per session, named by its id.
		let children: string[]
		try {
			children = await readdir(path)
		} catch {
			continue
		}
		let removedHere = 0
		for (const child of children) {
			if (!isEntityId(child, 'session')) continue
			const sessionDir = join(path, child)
			try {
				const inner = await lstat(sessionDir)
				if (!inner.isDirectory() || inner.isSymbolicLink() || !ownedBy(inner, getuid)) continue
			} catch {
				continue
			}
			if (await running(name, child)) continue
			if (!(await old(sessionDir))) continue
			try {
				await removeTree(sessionDir)
				removedSessions += 1
				removedHere += 1
			} catch {
				failed += 1
			}
		}
		if (removedHere > 0) {
			// Only an empty folder goes (rmdir refuses one that is not); one that holds anything stays.
			await rmdir(path).catch(() => undefined)
		}
	}
	for (const name of names) {
		if (!ALIAS.test(name)) continue
		const link = join(root, name)
		try {
			if (!(await lstat(link)).isSymbolicLink()) continue
			const target = await readlink(link)
			try {
				await stat(link)
				continue // the folder it names is still there
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
			}
			// Re-read before removing: a session may have just pointed the name at a new folder.
			if ((await readlink(link)) !== target) continue
			await unlink(link)
			removedAliases += 1
		} catch {
			// Removed by someone else first, or not ours to read.
		}
	}
	return { ran: true, removedSessions, removedHookEnv, removedAliases, failed }
}
