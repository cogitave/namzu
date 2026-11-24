/**
 * What Namzu keeps under its own home for one project, and how to delete it.
 *
 * A project's state is spread over a few places in the Namzu home, all named
 * by the project's slug: its folder under `projects/` (conversations,
 * checkpoints, file history, plans, memory, learning), the recovery copies in
 * `backups/projects/`, the memory inbox and usage files, and what an earlier
 * move left under `legacy/`. Two more places hold a line or a row per project:
 * `history.jsonl` (the prompts, named by the project's folder) and
 * `index.sqlite` (the rebuildable index).
 *
 * Nothing here touches the project's own folder, where settings files may be
 * committed. Every path is checked before it is measured and again before it is
 * deleted: it must be a real file or folder, never a link, and must sit inside
 * the real Namzu home.
 */

import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { isLeaseLive, readSessionLease, slugForCwd } from '@namzu/sdk'
import {
	promptHistoryPath,
	readPromptHistory,
	rewritePromptHistory,
} from '../sessions/prompt-history.js'
import { holderPidOf, processIsAlive } from '../sessions/session-watch.js'
import { findProject } from './project-lookup.js'

export type PurgeItemKind = 'folder' | 'file' | 'history' | 'index'

export interface PurgeItem {
	readonly kind: PurgeItemKind
	/** What it is, for the list a person confirms. */
	readonly what: string
	/** The path, or the file the lines or rows are in. */
	readonly path: string
	readonly files: number
	readonly bytes: number
	/** Lines or rows, for `history` and `index`. */
	readonly count?: number
}

export interface PurgeProject {
	readonly slug: string
	/** The project's folder, when its `project.json` says. */
	readonly folder: string | null
	/** The folders whose prompt-history lines belong to the project. */
	readonly folders: readonly string[]
	readonly items: readonly PurgeItem[]
	/** Why this project is left alone. Items are empty then. */
	readonly blocked?: string
}

export interface PurgePlan {
	readonly home: string
	readonly projects: readonly PurgeProject[]
	/** With `--all`: every line of the prompt history goes, whatever its folder. */
	readonly history?: PurgeItem
}

export interface PurgeSeams {
	readonly isProcessAlive?: (pid: number) => boolean
	readonly now?: () => number
}

const SLUG = /^[A-Za-z0-9._-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code
}

/** The real Namzu home, or `null` when it does not exist. */
async function realHomeOf(home: string): Promise<string | null> {
	try {
		return await realpath(home)
	} catch (error) {
		if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
		throw error
	}
}

function within(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * `'absent'` when nothing is there, `'ok'` for a real file or folder inside the
 * real home, otherwise the reason it must not be touched.
 */
async function checkPath(realHome: string, path: string): Promise<'absent' | 'ok' | string> {
	let entry: Awaited<ReturnType<typeof lstat>>
	try {
		entry = await lstat(path)
	} catch (error) {
		if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'absent'
		throw error
	}
	if (entry.isSymbolicLink()) return 'it is a link'
	const parent = path.slice(0, Math.max(path.lastIndexOf(sep), 0)) || sep
	let realParent: string
	try {
		realParent = await realpath(parent)
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return 'absent'
		throw error
	}
	if (!within(realHome, realParent)) {
		return 'it is outside the Namzu home'
	}
	// `services/<name>` is the home of a scheduler service, not a project's state.
	if (within(join(realHome, 'services'), path)) return 'it is a scheduler service’s home'
	return 'ok'
}

interface Measure {
	files: number
	bytes: number
}

/** Size of a folder by lstat, never entering a link. */
async function measure(path: string): Promise<Measure> {
	const total: Measure = { files: 0, bytes: 0 }
	const walk = async (current: string): Promise<void> => {
		const entry = await lstat(current)
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			total.files += 1
			total.bytes += entry.isSymbolicLink() ? 0 : entry.size
			return
		}
		for (const name of await readdir(current)) await walk(join(current, name))
	}
	await walk(path)
	return total
}

/** A folder that holds a live session of the project, if any: the process holding it. */
async function liveHolder(projectDir: string, seams: PurgeSeams): Promise<{ pid?: number } | null> {
	const now = seams.now?.() ?? Date.now()
	const alive = seams.isProcessAlive ?? processIsAlive
	let names: string[]
	try {
		names = await readdir(projectDir)
	} catch {
		return null
	}
	for (const name of names) {
		const dir = join(projectDir, name)
		let entry: Awaited<ReturnType<typeof lstat>>
		try {
			entry = await lstat(dir)
		} catch {
			continue
		}
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue
		const lease = await readSessionLease(dir).catch(() => null)
		if (lease === null || !isLeaseLive(lease, now)) continue
		const pid = holderPidOf(lease)
		// The lease runs for minutes after a killed process; where the holder is
		// a process of this machine, its absence says sooner that nobody is there.
		if (pid !== undefined && !alive(pid)) continue
		return pid === undefined ? {} : { pid }
	}
	return null
}

async function folderOf(projectFile: string): Promise<string | null> {
	try {
		const parsed = JSON.parse(await readFile(projectFile, 'utf8')) as { cwd?: unknown }
		return typeof parsed.cwd === 'string' ? parsed.cwd : null
	} catch {
		return null
	}
}

async function worktreesHeld(realHome: string, projectDir: string): Promise<boolean> {
	const dir = join(projectDir, 'worktrees')
	if ((await checkPath(realHome, dir)) !== 'ok') return false
	try {
		return (await readdir(dir)).length > 0
	} catch {
		return false
	}
}

const NODE_SQLITE = createRequire(import.meta.url)

interface Db {
	prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }
	exec(sql: string): void
	close(): void
}

function openIndex(path: string, readOnly: boolean): Db | null {
	try {
		const { DatabaseSync } = NODE_SQLITE('node:sqlite') as {
			DatabaseSync: new (p: string, o?: Record<string, unknown>) => Db
		}
		return new DatabaseSync(path, { readOnly })
	} catch {
		return null
	}
}

async function indexCount(
	realHome: string,
	slug: string,
): Promise<{ path: string; count: number } | null> {
	const path = join(realHome, 'index.sqlite')
	if ((await checkPath(realHome, path)) !== 'ok') return null
	const db = openIndex(path, true)
	if (db === null) return null
	try {
		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE slug = ?').get(slug) as
			| { n: number | bigint }
			| undefined
		const n = Number(row?.n ?? 0)
		const known = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE slug = ?').get(slug) as
			| { n: number | bigint }
			| undefined
		return n + Number(known?.n ?? 0) > 0 ? { path, count: n } : null
	} catch {
		return null
	} finally {
		db.close()
	}
}

/** Every project slug that has state under the home. */
async function allSlugs(realHome: string): Promise<string[]> {
	const slugs = new Set<string>()
	const add = (name: string): void => {
		if (SLUG.test(name) && !UUID.test(name) && !name.startsWith('.')) slugs.add(name)
	}
	for (const [dir, strip] of [
		['projects', ''],
		[join('backups', 'projects'), ''],
		['memory-inbox', '.jsonl'],
		['memory-usage', '.json'],
		['legacy', ''],
	] as const) {
		let names: string[]
		try {
			names = await readdir(join(realHome, dir))
		} catch {
			continue
		}
		for (const name of names)
			add(strip && name.endsWith(strip) ? name.slice(0, -strip.length) : name)
	}
	return [...slugs].sort()
}

async function planProject(
	realHome: string,
	slug: string,
	folders: ReadonlySet<string>,
	seams: PurgeSeams,
): Promise<PurgeProject> {
	if (!SLUG.test(slug)) throw new Error(`not a project name: ${slug}`)
	const projectDir = join(realHome, 'projects', slug)
	const projectFolder = await folderOf(join(projectDir, 'project.json'))
	const items: PurgeItem[] = []
	const places: ReadonlyArray<readonly [PurgeItemKind, string, string]> = [
		['folder', 'conversations, checkpoints, file history, plans, memory and learning', projectDir],
		['folder', 'recovery copies of settings files', join(realHome, 'backups', 'projects', slug)],
		[
			'folder',
			'state moved out of the project by `namzu state move legacy`',
			join(realHome, 'legacy', slug),
		],
		['file', 'memory inbox', join(realHome, 'memory-inbox', `${slug}.jsonl`)],
		['file', 'memory usage', join(realHome, 'memory-usage', `${slug}.json`)],
	]
	for (const [kind, what, path] of places) {
		const state = await checkPath(realHome, path)
		if (state === 'absent') continue
		if (state !== 'ok') {
			return {
				slug,
				folder: projectFolder,
				folders: [],
				items: [],
				blocked: `${path}: ${state}; nothing was deleted`,
			}
		}
		const size = await measure(path)
		items.push({ kind, what, path, files: size.files, bytes: size.bytes })
	}
	if (items.some((item) => item.path === projectDir)) {
		if (await worktreesHeld(realHome, projectDir)) {
			return {
				slug,
				folder: projectFolder,
				folders: [],
				items: [],
				blocked:
					'git worktrees Namzu made for it are still there; remove them first with `namzu worktree`, then purge',
			}
		}
		const holder = await liveHolder(projectDir, seams)
		if (holder !== null) {
			return {
				slug,
				folder: projectFolder,
				folders: [],
				items: [],
				blocked: `a session of this project is running${holder.pid === undefined ? '' : ` (process ${holder.pid})`}; stop it first`,
			}
		}
	}
	const mine = new Set([...folders, ...(projectFolder === null ? [] : [projectFolder])])
	if (mine.size > 0) {
		const history = await readPromptHistory(realHome)
		const count = history.entries.filter((entry) => mine.has(entry.project)).length
		if (count > 0) {
			items.push({
				kind: 'history',
				what: 'prompts in the prompt history',
				path: promptHistoryPath(realHome),
				files: 0,
				bytes: 0,
				count,
			})
		}
	}
	const indexed = await indexCount(realHome, slug)
	if (indexed !== null) {
		items.push({
			kind: 'index',
			what: 'rows in the session index',
			path: indexed.path,
			files: 0,
			bytes: 0,
			count: indexed.count,
		})
	}
	return { slug, folder: projectFolder, folders: [...mine], items }
}

/** What would be deleted for the project of `projectRoot`, a checkout folder. */
export async function planProjectPurge(
	home: string,
	projectRoot: string,
	seams: PurgeSeams = {},
): Promise<PurgePlan> {
	const realHome = await realHomeOf(home)
	if (realHome === null) return { home, projects: [] }
	const found = await findProject(realHome, projectRoot)
	const slug = found?.slug ?? slugForCwd(projectRoot)
	const project = await planProject(realHome, slug, new Set([projectRoot]), seams)
	return { home: realHome, projects: project.items.length > 0 || project.blocked ? [project] : [] }
}

/** What would be deleted for every project. */
export async function planAllPurge(home: string, seams: PurgeSeams = {}): Promise<PurgePlan> {
	const realHome = await realHomeOf(home)
	if (realHome === null) return { home, projects: [] }
	const projects: PurgeProject[] = []
	for (const slug of await allSlugs(realHome)) {
		const project = await planProject(realHome, slug, new Set(), seams)
		if (project.items.length > 0 || project.blocked) projects.push(project)
	}
	const lines = (await readPromptHistory(realHome)).entries.length
	// A project that is left alone keeps its prompts, and the file is not told apart by project here.
	const history: PurgeItem | undefined =
		lines > 0 && projects.every((project) => project.blocked === undefined)
			? {
					kind: 'history',
					what: 'prompts in the prompt history',
					path: promptHistoryPath(realHome),
					files: 0,
					bytes: 0,
					count: lines,
				}
			: undefined
	return { home: realHome, projects, ...(history ? { history } : {}) }
}

export interface PurgeOutcome {
	readonly slug: string
	readonly deleted: readonly string[]
	readonly failed: readonly string[]
}

function dropIndexRows(path: string, slug: string): void {
	const db = openIndex(path, false)
	if (db === null) throw new Error('the session index could not be opened')
	try {
		db.exec('PRAGMA busy_timeout = 5000')
		db.exec('BEGIN')
		const own = '(SELECT id FROM sessions WHERE slug = ?)'
		for (const table of [
			'turns',
			'pending_decisions',
			'external_refs',
			'children',
			'batches',
			'evidence_fts',
		]) {
			db.prepare(`DELETE FROM ${table} WHERE session_id IN ${own}`).run(slug)
		}
		db.prepare('DELETE FROM sessions WHERE slug = ?').run(slug)
		db.prepare('DELETE FROM projects WHERE slug = ?').run(slug)
		db.exec('COMMIT')
	} catch (error) {
		try {
			db.exec('ROLLBACK')
		} catch {
			// already ended
		}
		throw error
	} finally {
		db.close()
	}
}

/**
 * Delete what `plan` lists. Each path is checked again first; a path that
 * changed since the plan was made (now a link, or moved out) is left alone.
 * `all` also drops every prompt-history line, not only the named folders'.
 */
export async function executePurge(
	plan: PurgePlan,
	options: { readonly all: boolean },
	seams: PurgeSeams = {},
): Promise<PurgeOutcome[]> {
	const realHome = await realHomeOf(plan.home)
	const outcomes: PurgeOutcome[] = []
	for (const project of plan.projects) {
		const deleted: string[] = []
		const failed: string[] = []
		if (realHome === null || project.blocked !== undefined) {
			outcomes.push({ slug: project.slug, deleted, failed })
			continue
		}
		// The plan may be minutes old (a person reads the list and answers a
		// prompt): look again for a session that started since.
		if (project.items.some((item) => item.path === join(realHome, 'projects', project.slug))) {
			const holder = await liveHolder(join(realHome, 'projects', project.slug), seams)
			if (holder !== null) {
				failed.push(
					`${project.slug}: a session of this project is running${holder.pid === undefined ? '' : ` (process ${holder.pid})`}; left alone, stop it first`,
				)
				outcomes.push({ slug: project.slug, deleted, failed })
				continue
			}
		}
		const folders = new Set<string>(project.folders)
		for (const item of project.items) {
			try {
				if (item.kind === 'folder' || item.kind === 'file') {
					const state = await checkPath(realHome, item.path)
					if (state === 'absent') continue
					if (state !== 'ok') {
						failed.push(`${item.path}: ${state}`)
						continue
					}
					await rm(item.path, { recursive: item.kind === 'folder', force: true })
					deleted.push(item.path)
				} else if (item.kind === 'history') {
					const dropped = await rewritePromptHistory(
						realHome,
						(entry) => !folders.has(entry.project),
					)
					if (dropped > 0)
						deleted.push(`${dropped} prompt${dropped === 1 ? '' : 's'} in ${item.path}`)
				} else {
					dropIndexRows(item.path, project.slug)
					deleted.push(`rows in ${item.path}`)
				}
			} catch (error) {
				failed.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		outcomes.push({ slug: project.slug, deleted, failed })
	}
	if (plan.history !== undefined && realHome !== null && options.all) {
		const deleted: string[] = []
		const failed: string[] = []
		try {
			const dropped = await rewritePromptHistory(realHome, () => false)
			if (dropped > 0)
				deleted.push(`${dropped} prompt${dropped === 1 ? '' : 's'} in ${plan.history.path}`)
		} catch (error) {
			failed.push(`${plan.history.path}: ${error instanceof Error ? error.message : String(error)}`)
		}
		outcomes.push({ slug: '(prompt history)', deleted, failed })
	}
	return outcomes
}
