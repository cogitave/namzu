/**
 * Removing old conversations from this computer (`cleanupPeriodDays`).
 *
 * Conversation logs and their folders were kept forever. The terminal app now
 * removes a conversation whose log and folder have not changed for
 * `cleanupPeriodDays` (default 30) when it starts, at most once a day. What is
 * removed, all of it under `$NAMZU_HOME/projects/<slug>/`:
 *
 * - `<session-id>.jsonl`, the conversation, and `<session-id>/`, its folder
 *   (tool results, checkpoints, plans, tasks, goals, budgets, file history,
 *   sub-agent conversations), the log first, so a conversation is never left
 *   half there under a list that still shows it;
 * - a `<session-id>/` folder whose log is already gone, once it is as old;
 * - its scratch folder in the private temporary folder;
 * - the lines of `history.jsonl` older than the period.
 *
 * A conversation is kept, whatever its age, when:
 *
 * - its turn is open (running, or parked on a decision), the same gate an
 *   archive applies, or its writer lease is live: the sweep takes the lease
 *   before it removes anything, so a writer that starts meanwhile wins;
 * - its folder is not trusted, as for an archive;
 * - this process is about to open it, or a running Namzu has it on screen;
 * - the desktop app started it (the app keeps its own conversations, see
 *   `archiveInactive`);
 * - its log cannot be read: a damaged log is the person's to look at, not ours
 *   to finish off.
 *
 * Nothing outside `projects/` and the temporary folder is touched: not the
 * project's memory, learning, worktrees or `project.json`, not the shared
 * attachment store. The index is brought up to date afterwards.
 *
 * The first time an installation reaches the sweep with the default period, it
 * only counts and says so once; it removes nothing until seven days after that
 * notice, so nobody loses a month of conversations to an upgrade they did not
 * read about. A period the person set themselves applies at once.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
	DiskSessionLeaseStore,
	type SessionId,
	SessionPaths,
	type TempSweepReport,
	asSessionId,
	isEntityId,
	isLeaseLive,
	openSessionIndex,
	privateTempRootPath,
	readPeerRecords,
	readSessionLease,
	sweepPrivateTempRoot,
	withAccountLock,
} from '@namzu/sdk'
import { type LoadConfigOptions, loadBootstrapConfigWithProvenance } from '../../config/load.js'
import { resolvePeerRuntime } from '../peers/runtime.js'
import { rewritePromptHistory } from './prompt-history.js'
import { readConversationFacts } from './store.js'

/** Days a conversation is kept when nobody set `cleanupPeriodDays`. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30
/** The sweep runs at most this often. */
export const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000
/** After the first notice, the default period waits this long before it removes anything. */
export const CLEANUP_NOTICE_GRACE_MS = 7 * 24 * 60 * 60 * 1000
/** The state file under `NAMZU_HOME`: when the sweep last ran, and when it first told the person. */
export const CLEANUP_STATE_FILE = '.last-cleanup'
const DAY_MS = 24 * 60 * 60 * 1000
const LEASE_TTL_MS = 60_000
/** The most entries read inside one conversation folder to learn its age; a larger one counts as recent. */
const MAX_FOLDER_ENTRIES = 20_000

export interface CleanupState {
	/** When the sweep last ran, ISO. */
	readonly lastRunAt?: string
	/** When the person was first told that old conversations will be removed, ISO. */
	readonly noticeShownAt?: string
}

export interface ConversationCleanupOptions {
	readonly home: string
	/** Default `Date.now()`. */
	readonly now?: number
	/** `cleanupPeriodDays` in force; `undefined` when it could not be read, which removes nothing. */
	readonly periodDays: number | undefined
	/** Whether the person set the period (the default waits for its notice; theirs does not). */
	readonly explicit: boolean
	/** Conversation ids never to touch: the one this process opens. */
	readonly keep?: ReadonlySet<string>
	/** Whether a folder is trusted. Default: every folder is (tests); the terminal app passes its trust list. */
	readonly isTrusted?: (cwd: string) => boolean
	/** Conversations a running Namzu has on screen. Default: the live-session registry, by pid. */
	readonly onScreen?: () => ReadonlySet<string>
	/** Default `privateTempRootPath()`; `null` skips the temporary folder. */
	readonly tempRoot?: string | null
	/** Default {@link CLEANUP_EVERY_MS}; 0 runs every time. */
	readonly everyMs?: number
	/** The settings file the notice names. Default `<home>/config.yaml`. */
	readonly settingsFile?: string
}

export interface CleanupReport {
	/** False when the sweep was not due, another process was sweeping, or the period was unknown. */
	readonly ran: boolean
	/** `counted` while the default period waits for its notice: nothing was removed. */
	readonly mode: 'removed' | 'counted'
	/** Conversations removed, or that would have been. */
	readonly conversations: number
	/** Leftover conversation folders removed. */
	readonly folders: number
	/** Lines of `history.jsonl` removed. */
	readonly historyLines: number
	/** Conversations old enough that a gate kept. */
	readonly kept: number
	/** One sentence to show once, when the person should hear about the sweep. */
	readonly notice?: string
	readonly temp?: TempSweepReport
}

const NOT_RUN: CleanupReport = {
	ran: false,
	mode: 'counted',
	conversations: 0,
	folders: 0,
	historyLines: 0,
	kept: 0,
}

/**
 * The period in force, read from the user's own file and the managed file (a project file cannot
 * set it), and whether someone set it. `undefined` when the files cannot be read: the sweep then
 * removes nothing.
 */
export function readCleanupPeriod(
	options: Pick<LoadConfigOptions, 'home' | 'env'> = {},
): { readonly periodDays: number; readonly explicit: boolean } | undefined {
	try {
		const { config } = loadBootstrapConfigWithProvenance(options)
		return config.cleanupPeriodDays === undefined
			? { periodDays: DEFAULT_CLEANUP_PERIOD_DAYS, explicit: false }
			: { periodDays: config.cleanupPeriodDays, explicit: true }
	} catch {
		return undefined
	}
}

function readState(path: string): CleanupState {
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
		const v = value as Record<string, unknown>
		return {
			...(typeof v.lastRunAt === 'string' ? { lastRunAt: v.lastRunAt } : {}),
			...(typeof v.noticeShownAt === 'string' ? { noticeShownAt: v.noticeShownAt } : {}),
		}
	} catch {
		return {}
	}
}

function writeState(path: string, state: CleanupState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 })
	} catch {
		// A state that cannot be written means the next start sweeps again; nothing else.
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Conversations a running Namzu has registered as on screen, checked by their process id. */
function registeredOnScreen(home: string): ReadonlySet<string> {
	try {
		const runtime = resolvePeerRuntime(home)
		return new Set(
			readPeerRecords(runtime.sessionsDir)
				.filter((record) => pidAlive(record.pid))
				.map((record) => record.sessionId),
		)
	} catch {
		return new Set()
	}
}

/** The newest change of a file or of anything in a folder; `undefined` when it is too large to read. */
async function newestChange(path: string): Promise<number | undefined> {
	let newest = 0
	let seen = 0
	const pending = [path]
	while (pending.length > 0) {
		const current = pending.pop() as string
		let entry: Awaited<ReturnType<typeof lstat>>
		try {
			entry = await lstat(current)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw error
		}
		newest = Math.max(newest, entry.mtimeMs)
		if (!entry.isDirectory()) continue
		const names = await readdir(current)
		seen += names.length
		if (seen > MAX_FOLDER_ENTRIES) return undefined
		for (const name of names) pending.push(join(current, name))
	}
	return newest
}

interface Tally {
	conversations: number
	folders: number
	kept: number
}

async function sweepProject(
	home: string,
	slug: string,
	cutoff: number,
	remove: boolean,
	gates: {
		readonly keep: ReadonlySet<string>
		readonly onScreen: ReadonlySet<string>
		readonly isTrusted: (cwd: string) => boolean
		readonly tempRoot: string | null
	},
	tally: Tally,
): Promise<void> {
	const paths = new SessionPaths({ home, slug })
	const projectDir = paths.projectDir()
	let names: string[]
	try {
		names = await readdir(projectDir)
	} catch {
		return
	}
	const logs = new Set(
		names.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)),
	)
	const ids = new Set(
		[...logs, ...names.filter((name) => !name.includes('.'))].filter((id) =>
			isEntityId(id, 'session'),
		),
	)
	for (const raw of ids) {
		const id = asSessionId(raw)
		const logPath = paths.sessionLog({ sessionId: id })
		const dir = paths.sessionDir({ sessionId: id })
		try {
			if (gates.keep.has(raw) || gates.onScreen.has(raw)) {
				if (await isOld(logPath, dir, cutoff)) tally.kept += 1
				continue
			}
			if (!(await isOld(logPath, dir, cutoff))) continue
			const hasLog = logs.has(raw)
			if (hasLog) {
				const entry = await lstat(logPath)
				if (!entry.isFile()) {
					tally.kept += 1
					continue
				}
				const facts = await readConversationFacts({ paths }, id, 'tolerant').catch(() => null)
				if (
					!facts ||
					facts.activeTurn ||
					facts.started.origin?.protocol === 'desktop' ||
					!gates.isTrusted(facts.started.cwd)
				) {
					tally.kept += 1
					continue
				}
			} else {
				// A folder with no conversation: only a real folder, never one a writer holds.
				const entry = await lstat(dir)
				if (!entry.isDirectory()) continue
				if (isLeaseLive(await readSessionLease(dir).catch(() => null), Date.now())) {
					tally.kept += 1
					continue
				}
			}
			if (!remove) {
				if (hasLog) tally.conversations += 1
				else tally.folders += 1
				continue
			}
			if (await removeConversation(paths, id, hasLog, cutoff, gates.tempRoot, slug)) {
				if (hasLog) tally.conversations += 1
				else tally.folders += 1
			} else tally.kept += 1
		} catch {
			tally.kept += 1
		}
	}
}

async function isOld(logPath: string, dir: string, cutoff: number): Promise<boolean> {
	const [log, folder] = await Promise.all([newestChange(logPath), newestChange(dir)])
	if (log === undefined || folder === undefined) return false
	return Math.max(log, folder) < cutoff
}

/**
 * Take the conversation's writer lease, check again that nothing changed, then
 * remove the log and the folder. The lease lives in the folder, so it goes with
 * it; a writer that wanted the conversation meanwhile was refused, and one that
 * comes later finds no conversation.
 */
async function removeConversation(
	paths: SessionPaths,
	id: SessionId,
	hasLog: boolean,
	cutoff: number,
	tempRoot: string | null,
	slug: string,
): Promise<boolean> {
	const logPath = paths.sessionLog({ sessionId: id })
	const dir = paths.sessionDir({ sessionId: id })
	let lease = null
	if (hasLog) {
		lease = await new DiskSessionLeaseStore(dir).claim({
			holder: `namzu-cleanup:${process.pid}`,
			ttlMs: LEASE_TTL_MS,
		})
		if (!lease) return false
		const facts = await readConversationFacts({ paths }, id, 'tolerant').catch(() => null)
		// Claiming wrote the lease files, so the folder is new now: only the log's age is checked again.
		const log = await stat(logPath).catch(() => undefined)
		if (!facts || facts.activeTurn || !log || log.mtimeMs >= cutoff) {
			await new DiskSessionLeaseStore(dir).release(lease).catch(() => undefined)
			return false
		}
		await rm(logPath, { force: true })
	}
	await rm(dir, { recursive: true, force: true })
	if (tempRoot)
		await rm(join(tempRoot, slug, id), { recursive: true, force: true }).catch(() => undefined)
	return true
}

/**
 * Remove conversations older than `cleanupPeriodDays`, the lines of
 * `history.jsonl` older than that, and what sessions left in the temporary
 * folder. See the module header for what is kept. Never throws.
 */
export async function cleanupOldConversations(
	options: ConversationCleanupOptions,
): Promise<CleanupReport> {
	try {
		return await runCleanup(options)
	} catch {
		return NOT_RUN
	}
}

async function runCleanup(options: ConversationCleanupOptions): Promise<CleanupReport> {
	const { home, periodDays } = options
	// A period that could not be read removes nothing, as a broken settings file must never widen it.
	if (periodDays === undefined || !Number.isSafeInteger(periodDays) || periodDays < 1)
		return NOT_RUN
	const now = options.now ?? Date.now()
	const statePath = join(home, CLEANUP_STATE_FILE)
	return await withAccountLock(`${statePath}.lock`, async () => {
		const state = readState(statePath)
		const everyMs = options.everyMs ?? CLEANUP_EVERY_MS
		const last = state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN
		if (everyMs > 0 && Number.isFinite(last) && last <= now && now - last < everyMs) return NOT_RUN
		const noticeAt = state.noticeShownAt ? Date.parse(state.noticeShownAt) : Number.NaN
		const told = Number.isFinite(noticeAt)
		// The default period removes nothing until a week after the person was told about it.
		const waiting = !options.explicit && !(told && now - noticeAt >= CLEANUP_NOTICE_GRACE_MS)
		const kept: CleanupState = state.noticeShownAt ? { noticeShownAt: state.noticeShownAt } : {}
		// Written first, so a sweep that fails halfway is not tried again at every start.
		writeState(statePath, { lastRunAt: new Date(now).toISOString(), ...kept })

		const cutoff = now - periodDays * DAY_MS
		const tempRoot = options.tempRoot === undefined ? privateTempRootPath() : options.tempRoot
		const gates = {
			keep: options.keep ?? new Set<string>(),
			onScreen: options.onScreen ? options.onScreen() : registeredOnScreen(home),
			isTrusted: options.isTrusted ?? (() => true),
			tempRoot,
		}
		const tally: Tally = { conversations: 0, folders: 0, kept: 0 }
		let slugs: string[] = []
		try {
			const projects = join(home, 'projects')
			const top = await lstat(projects)
			if (top.isDirectory() && !top.isSymbolicLink()) slugs = await readdir(projects)
		} catch {
			slugs = []
		}
		for (const slug of slugs) {
			try {
				const entry = await lstat(join(home, 'projects', slug))
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue
			} catch {
				continue
			}
			await sweepProject(home, slug, cutoff, !waiting, gates, tally)
		}
		let historyLines = 0
		if (!waiting) {
			historyLines = await rewritePromptHistory(home, (entry) => entry.timestamp >= cutoff).catch(
				() => 0,
			)
			if (tally.conversations + tally.folders > 0) {
				// The index is rebuilt from the logs; opening it drops the rows of removed ones.
				const index = await openSessionIndex({ home }).catch(() => undefined)
				await index?.sync(home).catch(() => undefined)
				index?.close()
			}
		}
		const temp =
			tempRoot === null
				? undefined
				: await sweepPrivateTempRoot({
						root: tempRoot,
						now,
						keep: gates.keep,
						isSessionLive: async (slug, sessionId) =>
							gates.onScreen.has(sessionId) ||
							isLeaseLive(
								await readSessionLease(join(home, 'projects', slug, sessionId)),
								Date.now(),
							),
					}).catch(() => undefined)
		// The notice is given, and its week starts, only once there is something it is about.
		let notice: string | undefined
		if (!options.explicit && !told && tally.conversations > 0) {
			writeState(statePath, {
				lastRunAt: new Date(now).toISOString(),
				noticeShownAt: new Date(now).toISOString(),
			})
			const from = new Date(now + CLEANUP_NOTICE_GRACE_MS).toISOString().slice(0, 10)
			const count =
				tally.conversations === 1 ? '1 conversation' : `${tally.conversations} conversations`
			notice = `Namzu keeps conversations on this computer for ${periodDays} days. From ${from} it removes older ones: ${count} now. To keep them longer, set cleanupPeriodDays in ${options.settingsFile ?? join(home, 'config.yaml')}, for example to 3650.`
		}
		return {
			ran: true,
			mode: waiting ? 'counted' : 'removed',
			conversations: tally.conversations,
			folders: tally.folders,
			historyLines,
			kept: tally.kept,
			...(notice ? { notice } : {}),
			...(temp ? { temp } : {}),
		}
	})
}
