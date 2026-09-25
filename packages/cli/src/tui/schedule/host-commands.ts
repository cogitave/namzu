/**
 * `/schedule` and `/loop` in the TUI.
 *
 * `/schedule` lists the scheduled jobs with what needs you — a run waiting
 * for approval, a job waiting for confirmation or on hold — and acts on them:
 * confirm (the same preview `namzu schedule add` shows), pause, resume, run,
 * remove, and add a job by hand. A run waiting for approval is answered with
 * `/resume` of its conversation in its folder.
 */

import { resolve } from 'node:path'
import { describeSchedule, hostTimeZone } from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { JobRequestError, buildJob, confirmJob, previewLines } from '../../schedule/build.js'
import { changesBlock, changesSinceConfirmed } from '../../schedule/changes.js'
import { callEndpoint, readEndpoint } from '../../schedule/daemon/endpoint.js'
import { callsCount } from '../../schedule/fire/calls.js'
import { schedulePaths } from '../../schedule/paths.js'
import { compileJobPolicy, compileScriptCheckPolicy, isPresetName } from '../../schedule/policy.js'
import { parkedRunWords, resumeCommand } from '../../schedule/resume-command.js'
import { verifyScheduledScript } from '../../schedule/script-check.js'
import { readManifest } from '../../schedule/service/manifest.js'
import { appendHistory, readHistory } from '../../schedule/store/history.js'
import {
	confirmationHolds,
	createJob,
	deleteJob,
	findJob,
	listJobs,
	updateJob,
} from '../../schedule/store/jobs.js'
import { nextFireOf, readState } from '../../schedule/store/state.js'
import type { ScheduleJob } from '../../schedule/types.js'
import type { QuestionFn } from '../agent.js'
import { type SessionLoopScheduler, describeLoops } from './loop-host.js'

export interface ScheduleCommandContext {
	readonly home: string
	readonly cwd: string
	readonly config: Pick<NamzuCliConfig, 'limits'>
	readonly model?: { readonly provider: string; readonly model?: string }
	readonly say: (text: string) => void
	readonly ask: QuestionFn
}

const USAGE = [
	'/schedule                          jobs, and what needs you',
	'/schedule confirm <job>            confirm a job created without a terminal, or held after an edit',
	'/schedule pause|resume <job>',
	'/schedule run <job>                run it now through the scheduler',
	'/schedule remove <job>',
	'/schedule add <name> "<when>" <read-only|edit-in-folder> <prompt…>',
	'A run waiting for approval: /resume its conversation (⏲ <job> · <time>) in its folder.',
].join('\n')

async function schedulerLine(home: string): Promise<string> {
	const paths = schedulePaths(home)
	const endpoint = readEndpoint(paths.endpoint)
	if (endpoint && (await callEndpoint(endpoint, 'status', {}, 500))) return 'Scheduler: running.'
	let installed = false
	try {
		installed = readManifest(paths) !== undefined
	} catch {}
	return installed
		? 'Scheduler: installed but not answering — namzu schedule status.'
		: 'Scheduler: not installed — namzu schedule install. Jobs do not run until it is.'
}

function when(iso: string | undefined, tz: string): string {
	if (!iso) return '—'
	return new Intl.DateTimeFormat('en-GB', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: tz,
	}).format(new Date(iso))
}

export async function listScheduleJobs(ctx: ScheduleCommandContext): Promise<string> {
	const paths = schedulePaths(ctx.home)
	const { jobs, errors } = listJobs(paths)
	const lines: string[] = []
	for (const job of jobs) {
		const tz = job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
		const state = readState(paths, job.id)
		const mark =
			state.activeRun?.status === 'awaiting-approval'
				? state.activeRun.handoff
					? ` ⚠ ${parkedRunWords(state.activeRun)}`
					: ' ⚠ WAITING FOR YOUR APPROVAL'
				: job.state === 'pending-confirmation'
					? ' ⚠ needs confirmation'
					: job.state === 'active' && !confirmationHolds(job)
						? ' ⚠ changed outside namzu — on hold'
						: state.activeRun?.status === 'running'
							? ' ● running'
							: ''
		// `agent` (absent) is the common case and stays unmarked; `script`
		// costs no tokens at all, worth marking the same way `schedule list`
		// does on the command line.
		const kind =
			job.runKind === 'script'
				? '  [script, 0 tokens]'
				: job.runKind === 'script+agent'
					? '  [script+agent]'
					: ''
		lines.push(
			`⏲ ${job.name}  [${job.state}]${kind}${mark}\n    ${describeSchedule(job.schedule, { tz })} · next ${when(nextFireOf(job, state), tz)}${state.lastRun ? ` · last ${state.lastRun.status}${callsCount(state.lastRun) ? ` (${callsCount(state.lastRun)})` : ''} ${when(state.lastRun.endedAt, tz)}` : ''}\n    ${job.folder.canonical}`,
		)
		if (state.activeRun?.status === 'awaiting-approval' && state.activeRun.sessionId) {
			const command = resumeCommand(job, state.activeRun.sessionId)
			const verb = state.activeRun.handoff ? 'when that is done, continue it' : 'answer it'
			lines.push(
				job.folder.canonical === ctx.cwd
					? `    ${verb}: /resume and pick "⏲ ${job.name}", or ${command}`
					: `    ${verb}: ${command}`,
			)
		}
	}
	return [
		jobs.length === 0
			? errors.length > 0
				? 'No readable scheduled jobs.'
				: 'No scheduled jobs. Ask for one ("run this every night at 3"), or /schedule add.'
			: lines.join('\n'),
		...(errors.length > 0
			? [
					`${errors.length} job file${errors.length === 1 ? '' : 's'} could not be read; inspect or repair the files under NAMZU_HOME.`,
				]
			: []),
		await schedulerLine(ctx.home),
	].join('\n')
}

async function confirmInTui(
	ctx: ScheduleCommandContext,
	job: ScheduleJob,
	verb: string,
): Promise<'create' | 'create-paused' | 'cancel'> {
	const paths = schedulePaths(ctx.home)
	const layers = readPermissionLayers({ cwd: job.folder.canonical })
	const policy = compileJobPolicy(job.permissions, {
		layers,
		namzuHome: paths.home,
		folder: job.folder,
	})
	if (policy.diagnostics.length > 0) {
		ctx.say(`The rules do not compile: ${policy.diagnostics.join('; ')}`)
		return 'cancel'
	}
	const runKind = job.runKind ?? 'agent'
	if (runKind !== 'agent' && runKind !== 'script' && runKind !== 'script+agent') {
		ctx.say(`The job has an unknown run kind: ${String(runKind)}`)
		return 'cancel'
	}
	if (runKind !== 'agent') {
		if (!job.script) {
			ctx.say(`The ${runKind} job has no script recorded.`)
			return 'cancel'
		}
		const scriptPolicy = compileScriptCheckPolicy(job.permissions, {
			layers,
			namzuHome: paths.home,
			folder: job.folder,
		})
		const checked = verifyScheduledScript(job.script.body, job.script.shell, scriptPolicy)
		if (!checked.ok) {
			ctx.say(
				`The ${runKind === 'script' ? 'script' : 'wake-gate script'} was refused: ${checked.reason}`,
			)
			return 'cancel'
		}
	}
	const scriptSection =
		runKind !== 'agent' && job.script
			? [
					`${runKind === 'script' ? 'Script' : 'Wake-gate script'} (exactly as it will run, ${job.script.shell}; verified against the scheduled-run floor and every deny rule)`,
					...job.script.body.split('\n').map((line) => `  │ ${line}`),
				]
			: []
	ctx.say(
		[
			...previewLines(job, policy, new Date()),
			...changesBlock(changesSinceConfirmed(readHistory(paths, job.id))),
			...scriptSection,
			...(runKind === 'script'
				? []
				: [
						runKind === 'script+agent'
							? 'Prompt (used only when the wake-gate says wake: true)'
							: 'Prompt',
						...job.prompt.split('\n').map((l) => `  │ ${l}`),
					]),
		].join('\n'),
	)
	const answer = await ctx.ask({
		questionId: `schedule-confirm:${job.id}`,
		question: `${verb} the scheduled job "${job.name}"? (details above)`,
		header: 'Scheduled job',
		options: [
			{ id: 'cancel', label: 'Cancel', description: 'Change nothing' },
			{
				id: 'create-paused',
				label: `${verb} paused`,
				description: 'It does not run until resumed',
			},
			{ id: 'create', label: verb, description: 'It runs on schedule with the permissions above' },
		],
		multiSelect: false,
		allowFreeText: false,
	})
	if (answer.kind !== 'answer') return 'cancel'
	const id = answer.selectedOptionIds[0]
	return id === 'create' || id === 'create-paused' ? id : 'cancel'
}

/** Split `add` arguments: name, a quoted when, a preset, and the prompt. */
export function parseAddArgs(
	args: readonly string[],
): { name: string; when: string; preset: string; prompt: string } | undefined {
	const text = args.join(' ')
	const match = /^(\S+)\s+"([^"]+)"\s+(\S+)\s+([\s\S]+)$/.exec(text.trim())
	if (!match) return undefined
	return {
		name: match[1] as string,
		when: match[2] as string,
		preset: match[3] as string,
		prompt: match[4] as string,
	}
}

export async function runScheduleCommand(
	args: readonly string[],
	ctx: ScheduleCommandContext,
): Promise<void> {
	const paths = schedulePaths(ctx.home)
	const [verb, ...rest] = args
	try {
		switch (verb) {
			case undefined:
			case 'list':
				ctx.say(await listScheduleJobs(ctx))
				return
			case 'help':
				ctx.say(USAGE)
				return
			case 'confirm': {
				const job = findJob(paths, rest[0] ?? '')
				const answer = await confirmInTui(ctx, job, 'Confirm')
				if (answer === 'cancel') {
					ctx.say(`Not confirmed; ${job.name} stays ${job.state}.`)
					return
				}
				const now = new Date()
				const next = updateJob(paths, job.id, job.revision, (j) =>
					confirmJob(j, 'tui', now, { paused: answer === 'create-paused' }),
				)
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at: now.toISOString(),
					action: 'confirmed',
					by: 'tui',
				})
				ctx.say(`Confirmed ${next.name} (${next.state}).`)
				return
			}
			case 'pause':
			case 'resume': {
				const job = findJob(paths, rest[0] ?? '')
				if (verb === 'resume' && !confirmationHolds(job)) {
					ctx.say(`${job.name} changed since it was confirmed: /schedule confirm ${job.name}`)
					return
				}
				const now = new Date()
				updateJob(paths, job.id, job.revision, (j) =>
					verb === 'pause'
						? { ...j, state: 'paused', pausedAt: now.toISOString(), pausedBy: 'operator' }
						: { ...j, state: 'active', pausedAt: undefined, pausedBy: undefined },
				)
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at: now.toISOString(),
					action: verb === 'pause' ? 'paused' : 'resumed',
					by: 'operator',
				})
				ctx.say(`${job.name} ${verb === 'pause' ? 'paused' : 'resumed'}.`)
				return
			}
			case 'run': {
				const job = findJob(paths, rest[0] ?? '')
				const endpoint = readEndpoint(paths.endpoint)
				const answer = endpoint
					? await callEndpoint(endpoint, 'run-now', { jobId: job.id })
					: undefined
				ctx.say(
					answer
						? answer.ok
							? `${job.name} queued; /schedule shows it running.`
							: String(answer.message ?? 'refused')
						: `The scheduler is not running; run it here with: namzu schedule run-now ${job.name}`,
				)
				return
			}
			case 'remove': {
				const job = findJob(paths, rest[0] ?? '')
				const answer = await ctx.ask({
					questionId: `schedule-remove:${job.id}`,
					question: `Remove the scheduled job "${job.name}"? Its history is kept.`,
					options: [
						{ id: 'no', label: 'No' },
						{ id: 'yes', label: 'Remove it' },
					],
					multiSelect: false,
					allowFreeText: false,
				})
				if (answer.kind !== 'answer' || !answer.selectedOptionIds.includes('yes')) return
				deleteJob(paths, job.id)
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at: new Date().toISOString(),
					action: 'removed',
					by: 'operator',
				})
				ctx.say(`Removed ${job.name}.`)
				return
			}
			case 'add': {
				const parsed = parseAddArgs(rest)
				if (!parsed || !isPresetName(parsed.preset)) {
					ctx.say(
						`Usage: /schedule add <name> "<when>" <read-only|edit-in-folder> <prompt…>\nFor anything else: namzu schedule add --help`,
					)
					return
				}
				if (!ctx.model) {
					ctx.say('This session has no model yet; pick one first.')
					return
				}
				const now = new Date()
				const job = buildJob(
					{
						name: parsed.name,
						prompt: parsed.prompt,
						when: parsed.when,
						folder: resolve(ctx.cwd),
						permissions: { preset: parsed.preset },
						model: `${ctx.model.provider}${ctx.model.model ? `/${ctx.model.model}` : ''}`,
						createdBy: { surface: 'tui' },
					},
					{ paths, config: ctx.config, now },
				)
				const answer = await confirmInTui(ctx, job, 'Create')
				if (answer === 'cancel') {
					ctx.say('Not created.')
					return
				}
				const created = createJob(
					paths,
					confirmJob(job, 'tui', now, { paused: answer === 'create-paused' }),
				)
				appendHistory(paths, created.id, {
					v: 1,
					kind: 'job',
					at: now.toISOString(),
					action: 'created',
					by: 'tui',
				})
				ctx.say(`Created ${created.name} (${created.state}).`)
				return
			}
			default:
				ctx.say(USAGE)
		}
	} catch (error) {
		ctx.say(
			error instanceof JobRequestError || error instanceof Error ? error.message : String(error),
		)
	}
}

export async function runLoopCommand(
	args: readonly string[],
	loops: SessionLoopScheduler,
	say: (text: string) => void,
): Promise<void> {
	const [first, ...rest] = args
	try {
		if (!first || first === 'list') {
			say(describeLoops(loops.list()))
			return
		}
		if (first === 'stop') {
			const id = rest[0]
			if (!id) {
				say('Usage: /loop stop <id>|all')
				return
			}
			const stopped = await loops.delete(id)
			say(
				stopped === 0
					? `No loop has id ${id}.`
					: `Stopped ${stopped} loop${stopped === 1 ? '' : 's'}.`,
			)
			return
		}
		// `/loop <interval> <prompt>`; a cron expression is five words.
		const cron = args.length >= 6 && args.slice(0, 5).every((w) => /^[\d*/,\-a-z]+$/i.test(w))
		const interval = cron ? args.slice(0, 5).join(' ') : first
		const prompt = (cron ? args.slice(5) : rest).join(' ').trim()
		if (!prompt) {
			say('Usage: /loop <interval> <prompt or /command>   e.g. /loop 10m check the build')
			return
		}
		const loop = await loops.create({ interval, prompt, createdBy: 'operator' })
		say(
			`↻ Loop ${loop.id}: ${loop.schedule}, between turns, for 7 days. /loop stop ${loop.id} ends it.`,
		)
	} catch (error) {
		say(error instanceof Error ? error.message : String(error))
	}
}
