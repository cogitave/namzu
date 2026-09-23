/**
 * `schedule pause | resume | remove | run-now | prune`.
 *
 * Resuming does not catch up what came due while the job was paused: the
 * resume is a definition change, and the evaluator counts from it.
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
	NOOP_LOGGER,
	SessionPaths,
	asSessionId,
	generateScheduleRunId,
	openSessionIndex,
} from '@namzu/sdk'
import type { CommandContext } from '../../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../../exit-codes.js'
import { closeSessions, refreshIndex } from '../../integrations/sessions/store.js'
import { CLI_VERSION } from '../../version.js'
import { ScheduleDaemon } from '../daemon/daemon.js'
import { callEndpoint, readEndpoint } from '../daemon/endpoint.js'
import { type FireDependencies, runFire } from '../fire/fire.js'
import { isFinal, readRunResult } from '../fire/result.js'
import type { SchedulePaths } from '../paths.js'
import { claimOccurrence } from '../store/claims.js'
import { appendHistory, foldHistory, readHistory } from '../store/history.js'
import { confirmationHolds, deleteJob, findJob, listJobs, updateJob } from '../store/jobs.js'
import { readState, writeState } from '../store/state.js'
import type { ActiveRun, ScheduleRunResult } from '../types.js'
import { flag, has, interactive, parseArgs, parseMs, pathsFor } from './args.js'
import { askYesNo } from './confirm-prompt.js'

export async function pauseCommand(
	ctx: CommandContext,
	argv: readonly string[],
	resume = false,
): Promise<number> {
	const args = parseArgs(argv, ['home'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: `usage: namzu schedule ${resume ? 'resume' : 'pause'} <job>` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const job = findJob(paths, args.positionals[0])
		if (resume) {
			if (job.state !== 'paused') {
				ctx.formatter.error({ message: `${job.name} is ${job.state}, not paused` })
				return 1
			}
			if (!confirmationHolds(job)) {
				ctx.formatter.error({
					message: `${job.name} changed since it was confirmed; confirm it with \`namzu schedule confirm ${job.name}\``,
				})
				return 1
			}
		} else if (job.state !== 'active' && job.state !== 'pending-confirmation') {
			ctx.formatter.error({ message: `${job.name} is ${job.state}` })
			return 1
		}
		const now = new Date()
		const next = updateJob(paths, job.id, job.revision, (j) =>
			resume
				? { ...j, state: 'active', pausedAt: undefined, pausedBy: undefined }
				: { ...j, state: 'paused', pausedAt: now.toISOString(), pausedBy: 'operator' },
		)
		appendHistory(paths, job.id, {
			v: 1,
			kind: 'job',
			at: now.toISOString(),
			action: resume ? 'resumed' : 'paused',
			by: 'operator',
		})
		ctx.formatter.print({
			text: `${next.name} ${resume ? 'resumed' : 'paused'}.`,
			state: next.state,
		})
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return 1
	}
}

export async function removeCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'yes!', 'force!'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: 'usage: namzu schedule remove <job> [--yes] [--force]' })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const job = findJob(paths, args.positionals[0])
		const state = readState(paths, job.id)
		if (state.activeRun && !has(args, 'force')) {
			ctx.formatter.error({
				message: `${job.name} has a run ${state.activeRun.status === 'awaiting-approval' ? 'waiting for approval' : 'in progress'}; pass --force to remove the job anyway (the run is left to finish)`,
			})
			return 1
		}
		if (!has(args, 'yes')) {
			if (!interactive()) {
				ctx.formatter.error({ message: 'no terminal to confirm on; pass --yes' })
				return EXIT_USAGE
			}
			if (!(await askYesNo(`Remove the scheduled job ${job.name}? Its history is kept.`))) return 1
		}
		deleteJob(paths, job.id)
		appendHistory(paths, job.id, {
			v: 1,
			kind: 'job',
			at: new Date().toISOString(),
			action: 'removed',
			by: 'operator',
		})
		ctx.formatter.print({ text: `Removed ${job.name}.` })
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return 1
	}
}

/** The epoch a foreground `run-now` records its run under. */
const FOREGROUND_EPOCH = 'foreground'

export async function runNowCommand(
	ctx: CommandContext,
	argv: readonly string[],
	/** Test seam: what the foreground run is given. */
	fireDeps: Omit<FireDependencies, 'keepLogging'> = {},
): Promise<number> {
	const args = parseArgs(argv, ['home'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: 'usage: namzu schedule run-now <job>' })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const job = findJob(paths, args.positionals[0])
		const endpoint = readEndpoint(paths.endpoint)
		if (endpoint) {
			const answer = await callEndpoint(endpoint, 'run-now', { jobId: job.id })
			if (answer) {
				if (answer.ok) {
					ctx.formatter.print({
						text: `${job.name} queued with the scheduler; follow it with \`namzu schedule history ${job.name}\`.`,
					})
					return EXIT_OK
				}
				ctx.formatter.error({ message: String(answer.message ?? 'refused') })
				return 1
			}
		}
		// No daemon: run it here, in the foreground, with the same once-only claim.
		if (job.state !== 'active' || !confirmationHolds(job)) {
			ctx.formatter.error({ message: `${job.name} is not active and confirmed` })
			return 1
		}
		const state = readState(paths, job.id)
		if (state.activeRun) {
			ctx.formatter.error({ message: `${job.name} already has a run` })
			return 1
		}
		const runId = generateScheduleRunId()
		const key = `manual-${runId}`
		const startedAt = new Date().toISOString()
		if (
			!claimOccurrence(paths, {
				jobId: job.id,
				key,
				runId,
				daemonEpoch: FOREGROUND_EPOCH,
				at: startedAt,
			})
		)
			return 1
		ctx.formatter.info(`The scheduler is not running; running ${job.name} here.`)
		// Recorded as the job's run in progress, as a daemon's run is: a
		// scheduler that starts meanwhile adopts it instead of starting the
		// next occurrence beside it, and a park is found by `/resume`, held
		// against later occurrences and expired like any other.
		const run: ActiveRun = {
			runId,
			key,
			trigger: 'manual',
			startedAt,
			daemonEpoch: FOREGROUND_EPOCH,
			status: 'running',
		}
		writeState(paths, { ...readState(paths, job.id), activeRun: run })
		appendHistory(paths, job.id, {
			v: 1,
			kind: 'run',
			at: startedAt,
			runId,
			key,
			trigger: 'manual',
			startedAt,
			status: 'running',
		})
		// This terminal's logging stays as the operator set it; a run started by
		// the daemon writes JSON lines into its log file instead.
		const code = await runFire(
			ctx,
			paths,
			{ jobId: job.id, runId, key, revision: job.revision, trigger: 'manual' },
			{ ...fireDeps, keepLogging: true },
		)
		const written = readRunResult(paths, job.id, runId)
		const result: ScheduleRunResult = isFinal(written)
			? (written as ScheduleRunResult)
			: {
					v: 1,
					kind: 'schedule-run-result',
					runId,
					jobId: job.id,
					startedAt,
					...(written ?? {}),
					status: 'interrupted',
					exitCode: code || 1,
					reason: 'the run ended without recording a result',
				}
		await new ScheduleDaemon({
			paths,
			log: NOOP_LOGGER,
			version: CLI_VERSION,
			epoch: FOREGROUND_EPOCH,
			maxConcurrentRuns: 1,
			// The operator is at this terminal.
			notifications: false,
			spawnFire: () => {
				throw new Error('a foreground recorder starts no runs')
			},
			notify: async () => {},
			fingerprint: () => '',
		}).finalizeRun(job.id, runId, result)
		ctx.formatter.print({
			text: `${job.name}: ${result?.status ?? 'interrupted'}${result?.reason ? ` — ${result.reason}` : ''}${result?.sessionId ? `\nsession ${result.sessionId}` : ''}`,
			status: result?.status,
		})
		return code
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return 1
	}
}

/**
 * `schedule prune`: list — and with `--delete`, remove — run files and the
 * sessions of runs that ended before `--older-than` (default 30 days).
 * Sessions of runs still parked are never touched.
 *
 * A removed job's runs are included (without `--job`): `remove` keeps its
 * history and run files, and nothing else would ever reach them. Once none
 * of its runs is left, its history goes too.
 */
export async function pruneCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'job', 'older-than', 'delete!', 'yes!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const olderThan = parseMs('--older-than', flag(args, 'older-than')) ?? 30 * 86_400_000
	const cutoff = Date.now() - olderThan
	const live = flag(args, 'job')
		? [findJob(paths, flag(args, 'job') as string)]
		: listJobs(paths).jobs
	const subjects: { id: string; name: string; removed: boolean; active?: string }[] = live.map(
		(job) => {
			const active = readState(paths, job.id).activeRun?.runId
			return { id: job.id, name: job.name, removed: false, ...(active ? { active } : {}) }
		},
	)
	if (!flag(args, 'job')) {
		const known = new Set(listJobIds(paths))
		for (const id of removedJobIds(paths, known))
			subjects.push({ id, name: `removed job ${id}`, removed: true })
	}
	interface Doomed {
		readonly subject: (typeof subjects)[number]
		readonly runId: string
		readonly sessionId?: string
		readonly slug?: string
	}
	const doomed: Doomed[] = []
	/** Removed jobs every one of whose runs is doomed: their history goes too. */
	const emptied: (typeof subjects)[number][] = []
	for (const subject of subjects) {
		const kept = new Set<string>()
		const seen = new Set<string>()
		for (const r of foldHistory(readHistory(paths, subject.id))) {
			if (r.kind !== 'run') continue
			seen.add(r.runId)
			if (
				r.runId === subject.active ||
				r.status === 'awaiting-approval' ||
				r.status === 'running' ||
				!(Date.parse(r.endedAt ?? r.at) < cutoff)
			) {
				kept.add(r.runId)
				continue
			}
			const result = readRunResult(paths, subject.id, r.runId)
			doomed.push({
				subject,
				runId: r.runId,
				...(r.sessionId ? { sessionId: r.sessionId } : {}),
				...(result?.projectSlug ? { slug: result.projectSlug } : {}),
			})
		}
		// Run files history does not name (a removed job's, or a run that never
		// got a record): by the result's end time, else the file's.
		if (subject.removed) {
			for (const runId of runIdsOnDisk(paths, subject.id)) {
				if (seen.has(runId)) continue
				const result = readRunResult(paths, subject.id, runId)
				const ended = result?.endedAt
					? Date.parse(result.endedAt)
					: mtimeOf(paths, subject.id, runId)
				if (
					result?.status === 'running' ||
					result?.status === 'awaiting-approval' ||
					!(ended < cutoff)
				) {
					kept.add(runId)
					continue
				}
				doomed.push({
					subject,
					runId,
					...(result?.sessionId ? { sessionId: result.sessionId } : {}),
					...(result?.projectSlug ? { slug: result.projectSlug } : {}),
				})
			}
			if (kept.size === 0) emptied.push(subject)
		}
	}
	const lines = [
		...doomed.map(
			(d) => `${d.subject.name}  run ${d.runId}${d.sessionId ? `  session ${d.sessionId}` : ''}`,
		),
		...emptied.map((subject) => `${subject.name}  history`),
	]
	if (!has(args, 'delete')) {
		ctx.formatter.print(
			lines.length === 0
				? 'Nothing older than the cutoff.'
				: `Would delete ${doomed.length} runs${emptied.length > 0 ? ` and the history of ${emptied.length} removed jobs` : ''} (pass --delete):\n${lines.join('\n')}`,
		)
		return EXIT_OK
	}
	if (lines.length === 0) {
		ctx.formatter.print('Nothing older than the cutoff.')
		return EXIT_OK
	}
	ctx.formatter.info(`Deleting:\n${lines.join('\n')}`)
	if (!has(args, 'yes')) {
		if (!interactive()) {
			ctx.formatter.error({ message: 'no terminal to confirm on; pass --yes' })
			return EXIT_USAGE
		}
		if (!(await askYesNo('Delete these runs and their sessions?'))) return 1
	}
	const touched: { slug: string; sessionId: string }[] = []
	for (const d of doomed) {
		rmSync(paths.runResult(d.subject.id, d.runId), { force: true })
		rmSync(paths.runLog(d.subject.id, d.runId), { force: true })
		if (d.sessionId && d.slug) {
			const sp = new SessionPaths({ home: paths.home, slug: d.slug })
			const locator = { sessionId: asSessionId(d.sessionId) }
			rmSync(sp.sessionLog(locator), { force: true })
			rmSync(sp.sessionDir(locator), { recursive: true, force: true })
			touched.push({ slug: d.slug, sessionId: d.sessionId })
		}
	}
	for (const subject of emptied) {
		rmSync(paths.historyOf(subject.id), { force: true })
		rmSync(paths.runsOf(subject.id), { recursive: true, force: true })
	}
	// The session index learns each deleted session is gone. By slug, so a
	// removed job's folder need not be known.
	if (touched.length > 0) {
		try {
			const index = await openSessionIndex({ home: paths.home })
			try {
				for (const t of touched) {
					await refreshIndex(
						{ paths: new SessionPaths({ home: paths.home, slug: t.slug }), slug: t.slug, index },
						asSessionId(t.sessionId),
					).catch(() => undefined)
				}
			} finally {
				closeSessions({ index })
			}
		} catch {}
	}
	ctx.formatter.print({
		text: `Deleted ${doomed.length} runs${emptied.length > 0 ? ` and the history of ${emptied.length} removed jobs` : ''}.`,
	})
	return EXIT_OK
}

/** Job ids with a definition file. */
function listJobIds(paths: SchedulePaths): string[] {
	return namesIn(paths.jobs)
		.filter((n) => n.endsWith('.json'))
		.map((n) => n.slice(0, -'.json'.length))
}

/** Ids that have run files or history but no definition any more. */
function removedJobIds(paths: SchedulePaths, known: ReadonlySet<string>): string[] {
	const ids = new Set<string>([
		...namesIn(paths.runs),
		...namesIn(paths.history)
			.filter((n) => n.endsWith('.jsonl'))
			.map((n) => n.slice(0, -'.jsonl'.length)),
	])
	return [...ids].filter((id) => !known.has(id)).sort()
}

function runIdsOnDisk(paths: SchedulePaths, jobId: string): string[] {
	return [
		...new Set(
			namesIn(paths.runsOf(jobId))
				.filter((n) => n.endsWith('.json') || n.endsWith('.log'))
				.map((n) => n.replace(/\.(json|log)$/, '')),
		),
	]
}

function mtimeOf(paths: SchedulePaths, jobId: string, runId: string): number {
	for (const path of [paths.runResult(jobId, runId), paths.runLog(jobId, runId)]) {
		try {
			return statSync(path).mtimeMs
		} catch {}
	}
	return Number.NaN
}

function namesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

/** The size of what the scheduler keeps, for `status`. */
export function scheduleDiskUsage(root: string): number {
	let total = 0
	const visit = (dir: string) => {
		let names: string[]
		try {
			names = readdirSync(dir)
		} catch {
			return
		}
		for (const name of names) {
			const path = join(dir, name)
			try {
				const st = statSync(path)
				if (st.isDirectory()) visit(path)
				else total += st.size
			} catch {}
		}
	}
	visit(root)
	return total
}

export { EXIT_UNAVAILABLE }
