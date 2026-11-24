/**
 * `schedule service move <name>`: bring a service's home to
 * `<default home>/services/<name>`. This file holds the parts that touch the
 * home's files, so they can be tested without a supervisor: what a move
 * refuses, which paths inside the home must follow it, and which confirmations
 * it breaks.
 *
 * What a service home stores about its own place, and what the move does:
 * - `schedule/service.json` (`namzuHome`): rewritten by the reinstall.
 * - a no-project job (`workspace: none`) keeps its scratch folder beside the
 *   home (`<home>-schedule-workspaces/<job id>`); the folder moves with the
 *   home and the job's `folder` and `trust` paths are rewritten. The
 *   confirmation digest covers that folder, so those jobs need confirming
 *   again; the move never confirms for anyone.
 * - a job with a project folder stores that folder, not the home: untouched, and
 *   its confirmation holds.
 * - history, run logs and conversations may quote the old path as a record of
 *   what happened; they are left as written.
 * Every other `.json` file is searched for the old path, and a hit is reported
 * by name, never rewritten. Files that may hold a secret are not opened.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { SchedulePaths } from '../paths.js'
import { writeJsonAtomic } from '../store/atomic.js'
import { confirmationHolds, listJobs } from '../store/jobs.js'
import type { ScheduleJob } from '../types.js'

/** The scratch folder root a home's no-project jobs use: `<parent>/<basename>-schedule-workspaces`. */
export function scratchRootOf(home: string): string {
	const h = resolve(home)
	return join(dirname(h), `${basename(h)}-schedule-workspaces`)
}

/** The nearest folder at or above `path` that exists. */
export function nearestExisting(path: string): string {
	let current = resolve(path)
	while (!existsSync(current)) {
		const up = dirname(current)
		if (up === current) return current
		current = up
	}
	return current
}

/** Whether two paths are on the same file system, so a rename between them is one atomic step. */
export function sameFileSystem(a: string, b: string): boolean {
	try {
		return statSync(nearestExisting(a)).dev === statSync(nearestExisting(b)).dev
	} catch {
		return false
	}
}

export interface JobRewrite {
	readonly rewritten: readonly string[]
	/** Job names whose confirmation held before and no longer does: a person confirms them again. */
	readonly needConfirming: readonly string[]
	/** Job names whose confirmation still holds. */
	readonly stillConfirmed: readonly string[]
	readonly problems: readonly string[]
}

function underOld(path: string, oldScratch: string): boolean {
	return (
		path === oldScratch || path.startsWith(`${oldScratch}/`) || path.startsWith(`${oldScratch}\\`)
	)
}

/**
 * After the move: point each no-project job at its scratch folder in the new
 * place. `before` is each job's `confirmationHolds` as it was in the old place.
 * `listJobs` reads the files at the new home, which still say the old paths.
 */
export function rewriteJobPaths(
	paths: SchedulePaths,
	fromHome: string,
	toHome: string,
): JobRewrite {
	const oldScratch = scratchRootOf(fromHome)
	const newScratch = scratchRootOf(toHome)
	const rewritten: string[] = []
	const needConfirming: string[] = []
	const stillConfirmed: string[] = []
	const problems: string[] = []
	for (const job of listJobs(paths).jobs) {
		const held = confirmationHolds(job)
		let next: ScheduleJob = job
		if (
			job.workspace === 'none' &&
			underOld(job.folder.path, oldScratch) &&
			underOld(job.folder.canonical, oldScratch)
		) {
			const swap = (p: string) => join(newScratch, relative(oldScratch, p))
			next = {
				...job,
				folder: {
					...job.folder,
					path: swap(job.folder.path),
					canonical: swap(job.folder.canonical),
				},
				...(job.trust ? { trust: { ...job.trust, canonical: swap(job.trust.canonical) } } : {}),
			}
			try {
				writeJsonAtomic(paths.job(job.id), next)
				rewritten.push(job.name)
			} catch (error) {
				problems.push(
					`${job.name}: the job file could not be rewritten (${error instanceof Error ? error.message : String(error)})`,
				)
				continue
			}
		}
		if (!held) continue
		if (confirmationHolds(next)) stillConfirmed.push(job.name)
		else needConfirming.push(job.name)
	}
	return { rewritten, needConfirming, stillConfirmed, problems }
}

/** Names that may hold a secret: never opened. */
const SECRET_NAME = /(credential|secret|token|auth|keychain|\.env$|\.key$|\.pem$|^id_)/i
/** Folders that hold what happened, not what is configured. */
const RECORD_DIRS = new Set(['history', 'runs', 'log', 'sessions', 'node_modules', 'claims'])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 5000

/**
 * The `.json` files under `root` (relative to it) that still contain `needle`.
 * Records of past runs and files that may hold a secret are skipped.
 */
export function filesMentioning(root: string, needle: string): string[] {
	const found: string[] = []
	let seen = 0
	const walk = (dir: string): void => {
		let entries: Dirent[]
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (seen > MAX_FILES) return
			const path = join(dir, entry.name)
			if (entry.isSymbolicLink()) continue
			if (entry.isDirectory()) {
				if (!RECORD_DIRS.has(entry.name)) walk(path)
				continue
			}
			if (!entry.isFile() || !entry.name.endsWith('.json') || SECRET_NAME.test(entry.name)) continue
			seen++
			try {
				if (statSync(path).size > MAX_FILE_BYTES) continue
				if (readFileSync(path, 'utf8').includes(needle)) found.push(relative(root, path))
			} catch {
				// unreadable: not reported as a mention
			}
		}
	}
	walk(root)
	return found.sort()
}
