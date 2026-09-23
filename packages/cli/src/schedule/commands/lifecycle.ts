/**
 * `schedule pause | resume | remove | run-now | prune`.
 *
 * Resuming does not catch up what came due while the job was paused: the
 * resume is a definition change, and the evaluator counts from it.
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SessionPaths, asSessionId, generateScheduleRunId } from '@namzu/sdk'
import type { CommandContext } from '../../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../../exit-codes.js'
import { closeSessions, openSessions, refreshIndex } from '../../integrations/sessions/store.js'
import { callEndpoint, readEndpoint } from '../daemon/endpoint.js'
import { runFire } from '../fire/fire.js'
import { readRunResult } from '../fire/result.js'
import { claimOccurrence } from '../store/claims.js'
import { appendHistory, foldHistory, readHistory } from '../store/history.js'
import { confirmationHolds, deleteJob, findJob, listJobs, updateJob } from '../store/jobs.js'
import { readState } from '../store/state.js'
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

export async function runNowCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
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
				daemonEpoch: 'foreground',
				at: startedAt,
			})
		)
			return 1
		ctx.formatter.info(`The scheduler is not running; running ${job.name} here.`)
		// This terminal's logging stays as the operator set it; a run started by
		// the daemon writes JSON lines into its log file instead.
		const code = await runFire(
			ctx,
			paths,
			{ jobId: job.id, runId, key, revision: job.revision, trigger: 'manual' },
			{ keepLogging: true },
		)
		const result = readRunResult(paths, job.id, runId)
		appendHistory(paths, job.id, {
			v: 1,
			kind: 'run',
			at: new Date().toISOString(),
			runId,
			key,
			trigger: 'manual',
			startedAt,
			endedAt: result?.endedAt ?? new Date().toISOString(),
			status: result?.status ?? 'interrupted',
			exitCode: code,
			...(result?.sessionId ? { sessionId: result.sessionId } : {}),
			...(result?.reason ? { reason: result.reason } : {}),
			...(result?.summary ? { summary: result.summary } : {}),
		})
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
	const jobs = flag(args, 'job')
		? [findJob(paths, flag(args, 'job') as string)]
		: listJobs(paths).jobs
	const doomed: { job: (typeof jobs)[number]; runId: string; sessionId?: string; slug?: string }[] =
		[]
	for (const job of jobs) {
		const active = readState(paths, job.id).activeRun?.runId
		for (const r of foldHistory(readHistory(paths, job.id))) {
			if (
				r.kind !== 'run' ||
				r.runId === active ||
				r.status === 'awaiting-approval' ||
				r.status === 'running'
			)
				continue
			const ended = Date.parse(r.endedAt ?? r.at)
			if (!(ended < cutoff)) continue
			const result = readRunResult(paths, job.id, r.runId)
			doomed.push({
				job,
				runId: r.runId,
				...(r.sessionId ? { sessionId: r.sessionId } : {}),
				...(result?.projectSlug ? { slug: result.projectSlug } : {}),
			})
		}
	}
	const lines = doomed.map(
		(d) => `${d.job.name}  run ${d.runId}${d.sessionId ? `  session ${d.sessionId}` : ''}`,
	)
	if (!has(args, 'delete')) {
		ctx.formatter.print(
			doomed.length === 0
				? 'Nothing older than the cutoff.'
				: `Would delete ${doomed.length} runs (pass --delete):\n${lines.join('\n')}`,
		)
		return EXIT_OK
	}
	if (doomed.length === 0) {
		ctx.formatter.print('Nothing older than the cutoff.')
		return EXIT_OK
	}
	ctx.formatter.info(`Deleting ${doomed.length} runs:\n${lines.join('\n')}`)
	if (!has(args, 'yes')) {
		if (!interactive()) {
			ctx.formatter.error({ message: 'no terminal to confirm on; pass --yes' })
			return EXIT_USAGE
		}
		if (!(await askYesNo('Delete these runs and their sessions?'))) return 1
	}
	for (const d of doomed) {
		rmSync(paths.runResult(d.job.id, d.runId), { force: true })
		rmSync(paths.runLog(d.job.id, d.runId), { force: true })
		if (d.sessionId && d.slug) {
			const sp = new SessionPaths({ home: paths.home, slug: d.slug })
			const locator = { sessionId: asSessionId(d.sessionId) }
			rmSync(sp.sessionLog(locator), { force: true })
			rmSync(sp.sessionDir(locator), { recursive: true, force: true })
		}
	}
	for (const job of jobs) {
		try {
			const sessions = await openSessions(job.folder.canonical, { stateRoot: paths.home })
			try {
				for (const d of doomed.filter((x) => x.job.id === job.id && x.sessionId)) {
					await refreshIndex(sessions, asSessionId(d.sessionId as string)).catch(() => undefined)
				}
			} finally {
				closeSessions(sessions)
			}
		} catch {}
	}
	ctx.formatter.print({ text: `Deleted ${doomed.length} runs.` })
	return EXIT_OK
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
