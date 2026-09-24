/**
 * `schedule list`, `schedule show` and `schedule history`: read-only views.
 * `--json` prints the documented shapes (docs/cli/scheduled-tasks.md).
 */

import { describeSchedule, hostTimeZone } from '@namzu/sdk'
import type { CommandContext } from '../../commands/types.js'
import { readPermissionLayers } from '../../config/load.js'
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import { sanitizeLine } from '../../integrations/notifications/desktop/sanitize.js'
import { callsCount, callsLine } from '../fire/calls.js'
import { compileJobPolicy } from '../policy.js'
import { parkedRunWords, resumeCommand } from '../resume-command.js'
import { foldHistory, readHistory } from '../store/history.js'
import { confirmationHolds, findJob, listJobs } from '../store/jobs.js'
import { nextFireOf, readState } from '../store/state.js'
import type { ScheduleHistoryRecord, ScheduleJob, ScheduleJobState } from '../types.js'
import { flag, has, parseArgs, parseCount, pathsFor } from './args.js'

function tzOf(job: ScheduleJob): string {
	return job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
}

function when(iso: string | undefined, tz: string): string {
	if (!iso) return '—'
	return new Intl.DateTimeFormat('en-GB', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: tz,
	}).format(new Date(iso))
}

/** The state a person sees: pending jobs and held ones read differently. */
export function displayState(job: ScheduleJob): string {
	if (job.state === 'active' && !confirmationHolds(job)) return 'held (changed outside namzu)'
	if (job.state === 'pending-confirmation') return 'awaiting confirmation'
	if (job.state === 'paused' && job.pausedBy === 'auto-failure-streak') return 'paused (failing)'
	return job.state
}

export interface JobListing {
	readonly id: string
	readonly name: string
	readonly state: string
	readonly schedule: string
	readonly tz: string
	readonly folder: string
	readonly nextFireAt?: string
	readonly lastRun?: ScheduleJobState['lastRun']
	readonly activeRun?: {
		readonly status: string
		readonly sessionId?: string
		/** For a run waiting for approval: the command that opens it, folder included. */
		readonly resumeCommand?: string
		/** For a run a tool paused for a person: what the person has to do. */
		readonly handoff?: { readonly reason: string }
	}
}

export function listing(job: ScheduleJob, state: ScheduleJobState): JobListing {
	return {
		id: job.id,
		name: job.name,
		state: displayState(job),
		schedule: describeSchedule(job.schedule, { tz: tzOf(job) }),
		tz: tzOf(job),
		folder: job.folder.canonical,
		...(nextFireOf(job, state) ? { nextFireAt: nextFireOf(job, state) } : {}),
		...(state.lastRun ? { lastRun: state.lastRun } : {}),
		...(state.activeRun
			? {
					activeRun: {
						status: state.activeRun.status,
						...(state.activeRun.sessionId ? { sessionId: state.activeRun.sessionId } : {}),
						...(state.activeRun.status === 'awaiting-approval' && state.activeRun.sessionId
							? { resumeCommand: resumeCommand(job, state.activeRun.sessionId) }
							: {}),
						...(state.activeRun.status === 'awaiting-approval' && state.activeRun.handoff
							? { handoff: { reason: state.activeRun.handoff.reason } }
							: {}),
					},
				}
			: {}),
	}
}

export async function listCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const { jobs, errors } = listJobs(paths)
	const rows = jobs.map((job) => listing(job, readState(paths, job.id)))
	for (const error of errors) ctx.formatter.error({ message: error.message })
	if (has(args, 'json') || ctx.formatter.name !== 'text') {
		const payload = { v: 1, jobs: rows }
		ctx.formatter.print(ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload)
		return EXIT_OK
	}
	if (rows.length === 0) {
		// "No scheduled jobs" is only true when there is nothing at all;
		// `errors` above already said why each such file could not be read,
		// so this line says there is something, not nothing, to look at.
		ctx.formatter.print(
			errors.length > 0
				? `${errors.length} job file${errors.length === 1 ? '' : 's'} could not be read; see above.`
				: 'No scheduled jobs. Create one with `namzu schedule add`, or /schedule in the TUI.',
		)
		return EXIT_OK
	}
	const host = hostTimeZone()
	const lines = rows.map((r) => {
		const next = r.nextFireAt ? `next ${when(r.nextFireAt, r.tz)}` : ''
		const calls = r.lastRun ? callsCount(r.lastRun) : ''
		const last = r.lastRun
			? `last ${r.lastRun.status}${calls ? ` (${calls})` : ''} ${when(r.lastRun.endedAt, r.tz)}`
			: ''
		const active = r.activeRun
			? r.activeRun.status === 'awaiting-approval'
				? r.activeRun.handoff
					? parkedRunWords(r.activeRun)
					: 'WAITING FOR APPROVAL'
				: 'running'
			: ''
		const tzWarning = r.tz !== host ? ` (host is ${host})` : ''
		return [
			`${r.name}  [${r.state}]  ${r.schedule}${tzWarning}`,
			`  ${[active, next, last].filter(Boolean).join(' · ')}`,
			`  ${r.folder}`,
			...(r.activeRun?.resumeCommand
				? [
						r.activeRun.handoff
							? `  when that is done, continue it: ${r.activeRun.resumeCommand}`
							: `  answer it: ${r.activeRun.resumeCommand}`,
					]
				: []),
		].join('\n')
	})
	ctx.formatter.print(lines.join('\n'))
	return EXIT_OK
}

function describeRecord(r: ScheduleHistoryRecord, tz: string): string {
	switch (r.kind) {
		case 'run': {
			// `reason`/`summary` can carry a script's or a wake-gate's own
			// (untrusted) output; made safe for this text view the same way a
			// desktop notification already is, even though the producers of
			// both fields should already have.
			const reason = r.reason ? sanitizeLine(r.reason, 1_000) : undefined
			const summary = r.summary ? sanitizeLine(r.summary, 1_000) : undefined
			return `${when(r.startedAt, tz)}  run ${r.status}${r.trigger !== 'scheduled' ? ` (${r.trigger})` : ''}${r.delayedMs ? `, waited ${Math.round(r.delayedMs / 1000)} s for ${r.delayReason === 'folder-busy' ? 'the folder' : 'a slot'}` : ''}${reason ? `: ${reason}` : ''}${summary ? ` — ${summary}` : ''}${callsLine(r) ? `\n      ${callsLine(r)}` : ''}${r.sessionId ? `\n      session ${r.sessionId}` : ''}`
		}
		case 'skip':
			return `${when(r.at, tz)}  skipped ${r.count > 1 ? `${r.count} occurrences` : when(r.scheduledFor, tz)}: ${r.reason}`
		case 'missed':
			return `${when(r.at, tz)}  missed ${r.count}${r.capped ? '+' : ''} occurrence${r.count === 1 ? '' : 's'} (${when(r.from, tz)} to ${when(r.to, tz)}): ${r.reason}`
		case 'job':
			return `${when(r.at, tz)}  job ${r.action} by ${r.by}${r.detail ? `: ${r.detail}` : ''}`
	}
}

export async function showCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: 'usage: namzu schedule show <job> [--json]' })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const job = findJob(paths, args.positionals[0])
		const state = readState(paths, job.id)
		const history = foldHistory(readHistory(paths, job.id)).slice(0, 5)
		if (has(args, 'json') || ctx.formatter.name !== 'text') {
			const payload = { v: 1, job, state, history }
			ctx.formatter.print(
				ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload,
			)
			return EXIT_OK
		}
		const policy = compileJobPolicy(job.permissions, {
			layers: readPermissionLayers({ cwd: job.folder.canonical }),
			namzuHome: paths.home,
			folder: job.folder,
		})
		const tz = tzOf(job)
		ctx.formatter.print(
			[
				`${job.name}  [${displayState(job)}]  id ${job.id}`,
				`When        ${describeSchedule(job.schedule, { tz })}`,
				`Next        ${when(state.nextFireAt, tz)}`,
				`Folder      ${job.folder.canonical}`,
				...(state.activeRun?.status === 'awaiting-approval' && state.activeRun.sessionId
					? [
							state.activeRun.handoff
								? `Waiting     ${parkedRunWords(state.activeRun)}; when that is done, continue it: ${resumeCommand(job, state.activeRun.sessionId)}`
								: `Waiting     for approval; answer it: ${resumeCommand(job, state.activeRun.sessionId)}`,
						]
					: []),
				`Model       ${job.model.provider}${job.model.model ? `/${job.model.model}` : ''}`,
				`Budget      ${job.budget.tokenBudget} tokens, ${job.budget.maxIterations} iterations, ${Math.round(job.budget.timeoutMs / 60_000)} min`,
				`Confirmed   ${job.confirmation ? `${when(job.confirmation.at, tz)} (${job.confirmation.surface})` : 'not yet'}`,
				'Permissions',
				...policy.lines.map((l) => `  ${l}`),
				...(job.runKind && job.runKind !== 'agent' && job.script
					? [
							job.runKind === 'script' ? 'Script' : 'Wake-gate script',
							...job.script.body.split('\n').map((l) => `  ${l}`),
						]
					: []),
				...(job.prompt.trim() ? ['Prompt', ...job.prompt.split('\n').map((l) => `  ${l}`)] : []),
				'Recent',
				...(history.length === 0
					? ['  nothing yet']
					: history.map((r) => `  ${describeRecord(r, tz)}`)),
			].join('\n'),
		)
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return 1
	}
}

export async function historyCommand(
	ctx: CommandContext,
	argv: readonly string[],
): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!', 'limit'])
	if (args.unknown.length > 0 || !args.positionals[0]) {
		ctx.formatter.error({ message: 'usage: namzu schedule history <job> [--limit 20] [--json]' })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	try {
		const job = findJob(paths, args.positionals[0])
		const limit = parseCount('--limit', flag(args, 'limit')) ?? 20
		const records = foldHistory(readHistory(paths, job.id)).slice(0, limit)
		if (has(args, 'json') || ctx.formatter.name !== 'text') {
			const payload = { v: 1, job: { id: job.id, name: job.name }, records }
			ctx.formatter.print(
				ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload,
			)
			return EXIT_OK
		}
		const tz = tzOf(job)
		ctx.formatter.print(
			records.length === 0
				? `${job.name} has no history yet.`
				: records.map((r) => describeRecord(r, tz)).join('\n'),
		)
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return 1
	}
}
