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
import { readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
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
	/**
	 * Files that could not be read, with why. Never silently dropped. `id`/
	 * `name` are filled in when the raw JSON has them as strings — read
	 * leniently, without validating anything else about the file — so a job
	 * `readVersioned` refused (a newer namzu's format, a hand-broken file)
	 * is still nameable: `createJob`'s uniqueness check and `findJob` see it.
	 */
	readonly errors: {
		readonly path: string
		readonly message: string
		readonly id?: string
		readonly name?: string
	}[]
}

/** `id`/`name` read straight off the raw JSON, ignoring everything else — for a file the real reader refused. */
function identifyLeniently(path: string): { id?: string; name?: string } {
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
		return {
			...(typeof raw.id === 'string' ? { id: raw.id } : {}),
			...(typeof raw.name === 'string' ? { name: raw.name } : {}),
		}
	} catch {
		return {}
	}
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
				...identifyLeniently(path),
			})
		}
	}
	return { jobs: jobs.sort((a, b) => a.name.localeCompare(b.name)), errors }
}

/** How to tell one of several same-named or same-prefixed READABLE jobs from the rest. */
function addressReadable(job: ScheduleJob): string {
	return `${job.name} (id ${job.id}) — address it with the full id ${job.id} if its name ever collides again`
}

/** How to tell one of several same-named or same-prefixed UNREADABLE jobs from the rest. */
function addressUnreadable(job: JobListing['errors'][number]): string {
	return `id ${job.id ?? '(unknown, not recorded in the file)'} — its file could not be fully read (${job.message}); address it with the full id once it can be, or fix/remove the file`
}

/** A job by exact name or by an unambiguous id prefix (four characters at least). */
export function findJob(paths: SchedulePaths, ref: string): ScheduleJob {
	const { jobs, errors } = listJobs(paths)
	const byName = jobs.filter((j) => j.name === ref)
	const unreadableByName = errors.filter((e) => e.name === ref)
	if (byName.length + unreadableByName.length > 1) {
		throw ambiguity(ref, byName, unreadableByName)
	}
	if (byName.length === 1) return byName[0] as ScheduleJob
	if (unreadableByName.length === 1) {
		const only = unreadableByName[0] as NonNullable<(typeof unreadableByName)[number]>
		throw new Error(`"${ref}" exists but its file could not be fully read: ${only.message}`)
	}
	if (ref.length >= 4) {
		const lower = ref.toLowerCase()
		const byId = jobs.filter((j) => j.id.startsWith(lower))
		const unreadableById = errors.filter((e) => e.id?.toLowerCase().startsWith(lower))
		if (byId.length + unreadableById.length > 1) {
			throw ambiguity(ref, byId, unreadableById)
		}
		if (byId.length === 1) return byId[0] as ScheduleJob
		if (unreadableById.length === 1) {
			const only = unreadableById[0] as NonNullable<(typeof unreadableById)[number]>
			throw new Error(
				`"${ref}" matches a job whose file could not be fully read (id ${only.id}): ${only.message}`,
			)
		}
	}
	throw new ScheduleJobNotFoundError(ref)
}

function ambiguity(
	ref: string,
	readable: readonly ScheduleJob[],
	unreadable: readonly JobListing['errors'][number][],
): Error {
	const total = readable.length + unreadable.length
	const parts = [...readable.map(addressReadable), ...unreadable.map(addressUnreadable)]
	return new Error(`"${ref}" matches ${total} jobs: ${parts.join('; ')}.`)
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
	const { jobs, errors } = listJobs(paths)
	if (jobs.some((j) => j.name === job.name)) {
		throw new Error(`A job named "${job.name}" already exists.`)
	}
	// A file `readVersioned` could not fully parse is still a real job with
	// this name as far as uniqueness goes — leniently read, so it is not
	// invisible to this check just because the real reader refused it.
	const unreadable = errors.find((e) => e.name === job.name)
	if (unreadable) {
		throw new Error(
			`A job named "${job.name}" already exists, in a file that could not be fully read (${unreadable.message}); rename this one, or fix/remove ${unreadable.path} first.`,
		)
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
