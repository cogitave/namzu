/**
 * Job definitions: `schedule/jobs/<job-id>.json`.
 *
 * A job changes only by an operator action — the CLI, the TUI, a confirmed
 * tool call — or by the daemon's own lifecycle transitions (completed,
 * expired, paused after failures, held after an edit it did not make). Every
 * write is a compare-and-set on `revision`: the writer first publishes a
 * revision marker `jobs/.revisions/<job-id>/<n>` with `link`, and only the one
 * writer that published marker `n` writes revision `n`. Two writers that read
 * the same revision cannot both win; the loser gets
 * {@link ScheduleConflictError} and re-reads.
 *
 * A hand edit of the JSON skips all of this. That is not prevented — the file
 * is the operator's — but it is caught: the job's confirmation digest no
 * longer matches, and the daemon holds the job until someone confirms it.
 */

import { createHash } from 'node:crypto'
import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { SchedulePaths } from '../paths.js'
import { SCHEDULE_FORMAT_VERSION, type ScheduleJob, jobFormatVersion } from '../types.js'
import {
	ScheduleFormatError,
	ensureDir,
	publishExclusive,
	readVersioned,
	writeJsonAtomic,
} from './atomic.js'

export const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A revision marker older than this whose revision never landed was abandoned by a crashed writer. */
const ABANDONED_MARKER_MS = 60_000
const KEEP_MARKERS = 8

export class ScheduleConflictError extends Error {
	override readonly name = 'ScheduleConflictError'
	constructor(readonly jobId: string) {
		super(`Job ${jobId} changed while it was being edited; read it again and retry.`)
	}
}

export class ScheduleJobNotFoundError extends Error {
	override readonly name = 'ScheduleJobNotFoundError'
	constructor(readonly ref: string) {
		super(`No scheduled job is named or starts with "${ref}".`)
	}
}

/** JSON with object keys sorted, so a digest does not depend on write order. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

/**
 * The digest of what a confirmation vouches for: the prompt, the folder and
 * its trust, the permissions, the schedule, the model, the budget, the
 * approval window, the pinned project config, and — when the job runs one —
 * the script's exact text, shell and timeout. Not a secret — a tripwire: a
 * later change to the script needs re-confirmation exactly as a change to
 * the prompt does, through this same digest, not a second mechanism.
 *
 * `runKind`/`script`/`wakeGate` are folded in only when the job actually has
 * a non-`agent` `runKind`: an ordinary `agent` job's digest is byte-for-byte
 * what it always was, so upgrading namzu never holds an already-confirmed
 * `v:1` job that this design never touched.
 */
export function jobSecurityDigest(job: ScheduleJob): string {
	const script =
		job.runKind !== undefined && job.runKind !== 'agent'
			? { runKind: job.runKind, script: job.script ?? null, wakeGate: job.wakeGate ?? null }
			: {}
	return createHash('sha256')
		.update(
			stableStringify({
				prompt: job.prompt,
				folder: job.folder.canonical,
				trust: job.trust?.canonical ?? null,
				permissions: job.permissions,
				schedule: job.schedule,
				model: job.model,
				budget: job.budget,
				approvalTtlMs: job.approvalTtlMs,
				projectDigest: job.projectDigest,
				...script,
			}),
		)
		.digest('hex')
}

/** Whether a job's confirmation still vouches for what the file says. */
export function confirmationHolds(job: ScheduleJob): boolean {
	return job.confirmation !== null && job.confirmation.digest === jobSecurityDigest(job)
}

export function readJob(paths: SchedulePaths, id: string): ScheduleJob | undefined {
	return readVersioned<ScheduleJob>(paths.job(id), 'schedule-job', SCHEDULE_FORMAT_VERSION)
}

export interface JobListing {
	readonly jobs: ScheduleJob[]
	/** Files that could not be read, with why. Never silently dropped. */
	readonly errors: { readonly path: string; readonly message: string }[]
}

export function listJobs(paths: SchedulePaths): JobListing {
	let names: string[]
	try {
		names = readdirSync(paths.jobs)
	} catch {
		return { jobs: [], errors: [] }
	}
	const jobs: ScheduleJob[] = []
	const errors: JobListing['errors'] = []
	for (const name of names.sort()) {
		if (!name.endsWith('.json') || name.startsWith('.')) continue
		const path = join(paths.jobs, name)
		try {
			const job = readVersioned<ScheduleJob>(path, 'schedule-job', SCHEDULE_FORMAT_VERSION)
			if (job) jobs.push(job)
		} catch (error) {
			errors.push({
				path,
				message: error instanceof ScheduleFormatError ? error.message : String(error),
			})
		}
	}
	return { jobs: jobs.sort((a, b) => a.name.localeCompare(b.name)), errors }
}

/** A job by exact name or by an unambiguous id prefix (four characters at least). */
export function findJob(paths: SchedulePaths, ref: string): ScheduleJob {
	const { jobs } = listJobs(paths)
	const byName = jobs.find((j) => j.name === ref)
	if (byName) return byName
	if (ref.length >= 4) {
		const matches = jobs.filter((j) => j.id.startsWith(ref.toLowerCase()))
		if (matches.length === 1) return matches[0] as ScheduleJob
		if (matches.length > 1) {
			throw new Error(
				`"${ref}" matches ${matches.length} jobs (${matches.map((j) => j.name).join(', ')}); use the name.`,
			)
		}
	}
	throw new ScheduleJobNotFoundError(ref)
}

function markerDir(paths: SchedulePaths, id: string): string {
	return join(paths.jobs, '.revisions', id)
}

/** Win revision `n` of a job, or learn that someone else did. */
function claimRevision(paths: SchedulePaths, id: string, current: number): number {
	const dir = markerDir(paths, id)
	ensureDir(dir)
	let target = current + 1
	for (let attempt = 0; attempt < 16; attempt++) {
		if (
			publishExclusive(join(dir, String(target)), {
				at: new Date().toISOString(),
				pid: process.pid,
			})
		)
			return target
		// Somebody holds `target`. If it never landed and is old, its writer
		// crashed between the marker and the document; step over it.
		let age = 0
		try {
			age = Date.now() - statSync(join(dir, String(target))).mtimeMs
		} catch {
			age = 0
		}
		const landed = (readJob(paths, id)?.revision ?? 0) >= target
		if (landed || age < ABANDONED_MARKER_MS) throw new ScheduleConflictError(id)
		target += 1
	}
	throw new ScheduleConflictError(id)
}

function pruneMarkers(paths: SchedulePaths, id: string, latest: number): void {
	const dir = markerDir(paths, id)
	try {
		for (const name of readdirSync(dir)) {
			const n = Number(name)
			if (Number.isSafeInteger(n) && n < latest - KEEP_MARKERS) unlinkSync(join(dir, name))
		}
	} catch {}
}

/** Write a new job. Refuses a name another job has. */
export function createJob(paths: SchedulePaths, job: ScheduleJob): ScheduleJob {
	if (!JOB_NAME.test(job.name)) {
		throw new Error(
			`"${job.name}" is not a job name: lowercase letters, digits and dashes, starting with a letter or digit.`,
		)
	}
	const { jobs } = listJobs(paths)
	if (jobs.some((j) => j.name === job.name)) {
		throw new Error(`A job named "${job.name}" already exists.`)
	}
	ensureDir(paths.jobs)
	claimRevision(paths, job.id, 0)
	const created = { ...job, revision: 1 }
	writeJsonAtomic(paths.job(job.id), created)
	return created
}

/**
 * Change a job, compare-and-set on the revision read. `mutate` returns the
 * new body; revision and `updatedAt` are set here.
 */
export function updateJob(
	paths: SchedulePaths,
	id: string,
	expectedRevision: number,
	mutate: (job: ScheduleJob) => ScheduleJob,
	now: Date = new Date(),
): ScheduleJob {
	const current = readJob(paths, id)
	if (!current) throw new ScheduleJobNotFoundError(id)
	if (current.revision !== expectedRevision) throw new ScheduleConflictError(id)
	const revision = claimRevision(paths, id, current.revision)
	const mutated = mutate(current)
	const next: ScheduleJob = {
		...mutated,
		id: current.id,
		// A job that does not touch `runKind`/`script` keeps its file at
		// whatever version it already read at (usually `v:1`), so an
		// unrelated edit never forces a re-confirmation cycle a v:1 job never
		// needed. One that gains a non-`agent` runKind is written at the
		// current version from here on.
		v: jobFormatVersion(mutated),
		kind: 'schedule-job',
		revision,
		updatedAt: now.toISOString(),
	}
	writeJsonAtomic(paths.job(id), next)
	pruneMarkers(paths, id, revision)
	return next
}

/** Remove a job's definition, markers, state and claims. History is kept. */
export function deleteJob(paths: SchedulePaths, id: string): void {
	rmSync(paths.job(id), { force: true })
	rmSync(markerDir(paths, id), { recursive: true, force: true })
	rmSync(paths.stateOf(id), { force: true })
	rmSync(paths.claimsOf(id), { recursive: true, force: true })
}
