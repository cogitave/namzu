/**
 * `/schedule` and `/loop` in the TUI.
 *
 * `/schedule` lists the scheduled jobs with what needs you — a run waiting
 * for approval, a job waiting for confirmation or on hold — and acts on them:
 * confirm (the same preview `namzu schedule add` shows), pause, resume, run,
 * remove, and add a job by hand. A run waiting for approval is answered with
 * `/resume` of its conversation in its folder.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import {
	type ScheduleJobPreview,
	describeSchedule,
	hostTimeZone,
	installedCommandShellForDialect,
	upcomingFireTimes,
} from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import {
	JobRequestError,
	buildJob,
	confirmJob,
	previewLines,
	runsPerDay,
} from '../../schedule/build.js'
import { changesBlock, changesSinceConfirmed } from '../../schedule/changes.js'
import { callEndpoint, readEndpoint } from '../../schedule/daemon/endpoint.js'
import { callsCount } from '../../schedule/fire/calls.js'
import { schedulePaths } from '../../schedule/paths.js'
import {
	allowsCommands,
	compileJobPolicy,
	compileScriptCheckPolicy,
	isPresetName,
} from '../../schedule/policy.js'
import { parkedRunWords, resumeCommand } from '../../schedule/resume-command.js'
import { verifyScheduledScript } from '../../schedule/script-check.js'
import { scriptShellUnavailableReason } from '../../schedule/script-shell.js'
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
import { visibleScheduleMessage } from '../../schedule/visible-source.js'
import type { ScheduleReviewAnswer, ScheduleReviewRequest } from '../ScheduleReviewOverlay.js'
import type { QuestionFn } from '../agent.js'
import { type SessionLoopScheduler, describeLoops } from './loop-host.js'

export interface ScheduleCommandContext {
	readonly home: string
	readonly cwd: string
	readonly config: Pick<NamzuCliConfig, 'limits'>
	readonly model?: { readonly provider: string; readonly model?: string }
	readonly sourceConversation?: ScheduleJobPreview['delivery']
	readonly say: (text: string) => void
	readonly ask: QuestionFn
	readonly extraRoots?: readonly string[]
	readonly review?: (
		request: ScheduleReviewRequest,
		signal?: AbortSignal,
	) => Promise<ScheduleReviewAnswer>
}

const USAGE = [
	'/schedule                          jobs, and what needs you',
	'/schedule confirm <job>            confirm a job created without a terminal, or held after an edit',
	'/schedule pause|resume <job>',
	'/schedule run <job>                run it now through the scheduler',
	'/schedule remove <job>',
	'/schedule add <name> "<when>" <read-only|edit-in-folder> <prompt…>',
	'A run waiting for approval: /resume its conversation (Scheduled: <job> · <time>) in its folder.',
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
					? `  [${parkedRunWords(state.activeRun)}]`
					: '  [waiting for your approval]'
				: job.state === 'pending-confirmation'
					? '  [needs confirmation]'
					: job.state === 'active' && !confirmationHolds(job)
						? '  [on hold: changed outside namzu]'
						: state.activeRun?.status === 'running'
							? '  [running]'
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
			`${job.name}  [${job.state}]${kind}${mark}\n    ${describeSchedule(job.schedule, { tz })} · next ${when(nextFireOf(job, state), tz)}${state.lastRun ? ` · last ${state.lastRun.status}${callsCount(state.lastRun) ? ` (${callsCount(state.lastRun)})` : ''} ${when(state.lastRun.endedAt, tz)}` : ''}\n    ${job.workspace === 'none' ? 'Private scheduler workspace (no project)' : job.folder.canonical}`,
		)
		if (job.delivery?.kind === 'source-conversation')
			lines.push(`    Results return to source conversation ${job.delivery.sessionId}`)
		if (state.activeRun?.status === 'awaiting-approval' && state.activeRun.sessionId) {
			const command = resumeCommand(job, state.activeRun.sessionId)
			const verb = state.activeRun.handoff ? 'when that is done, continue it' : 'answer it'
			lines.push(
				job.folder.canonical === ctx.cwd
					? `    ${verb}: /resume and pick "Scheduled: ${job.name}", or ${command}`
					: `    ${verb}: ${command}`,
			)
		}
	}
	return visibleScheduleMessage(
		[
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
		].join('\n'),
	)
}

async function confirmInTui(
	ctx: ScheduleCommandContext,
	job: ScheduleJob,
	verb: string,
): Promise<'create' | 'create-paused' | 'cancel'> {
	const say = (message: string) => ctx.say(visibleScheduleMessage(message))
	const paths = schedulePaths(ctx.home)
	const layers = readPermissionLayers({
		cwd: job.folder.canonical,
		home: ctx.home,
		...(job.workspace === 'none' ? { includeProject: false } : {}),
	})
	const policy = compileJobPolicy(job.permissions, {
		layers,
		namzuHome: paths.home,
		folder: job.folder,
	})
	if (policy.diagnostics.length > 0) {
		say(`The rules do not compile: ${policy.diagnostics.join('; ')}`)
		return 'cancel'
	}
	const runKind = job.runKind ?? 'agent'
	if (runKind !== 'agent' && runKind !== 'script' && runKind !== 'script+agent') {
		say(`The job has an unknown run kind: ${String(runKind)}`)
		return 'cancel'
	}
	if (runKind !== 'agent') {
		if (!job.script) {
			say(`The ${runKind} job has no script recorded.`)
			return 'cancel'
		}
		const selectedShell = installedCommandShellForDialect(job.script.shell)
		if (!selectedShell) {
			say(scriptShellUnavailableReason(job.script.shell))
			return 'cancel'
		}
		const scriptPolicy = compileScriptCheckPolicy(job.permissions, {
			layers,
			namzuHome: paths.home,
			folder: job.folder,
		})
		const checked = verifyScheduledScript(job.script.body, selectedShell.dialect, scriptPolicy)
		if (!checked.ok) {
			say(
				`The ${runKind === 'script' ? 'script' : 'wake-gate script'} was refused: ${checked.reason}`,
			)
			return 'cancel'
		}
	}
	const scriptSection =
		runKind !== 'agent' && job.script
			? [
					`${runKind === 'script' ? 'Script' : 'Wake-gate script'} (exactly as it will run, ${job.script.shell}; shell commands checked against the scheduled-run floor and deny rules)`,
					...job.script.body.split('\n').map((line) => `  │ ${line}`),
					...(job.script.report === 'json-v1'
						? [
								'Script report: JSON v1 (quiet/changed; optional scheduler state); stdout must be one JSON object line.',
							]
						: []),
					'Code passed to another interpreter is not parsed by the shell checker; review it here.',
				]
			: []
	const now = new Date()
	const fullText = visibleScheduleMessage(
		[
			...previewLines(job, policy, now),
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
	if (ctx.review) {
		const roots = [ctx.cwd, ...(ctx.extraRoots ?? [])]
		const outside =
			job.workspace !== 'none' &&
			!roots.some((root) => {
				const rel = relative(root, job.folder.canonical)
				return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
			})
		const hasScript = runKind !== 'agent'
		const networkCapable =
			policy.network ||
			(job.permissions.execution === 'host' && (hasScript || allowsCommands(job.permissions)))
		const tz = job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
		const preview: ScheduleJobPreview = {
			name: job.name,
			folder: job.folder.canonical,
			...(job.workspace === 'none' ? { workspace: 'none' as const } : {}),
			...(job.delivery ? { delivery: job.delivery } : {}),
			outsideSessionRoots: outside,
			prompt: job.prompt,
			...(hasScript ? { runKind } : {}),
			...(job.script ? { script: job.script } : {}),
			schedule: describeSchedule(job.schedule, { tz }),
			nextFireTimes: upcomingFireTimes(job.schedule, now, 3).map((fire) => fire.toISOString()),
			rules: policy.lines,
			unmatched: job.permissions.unmatched,
			execution: job.permissions.execution,
			networkAccess: networkCapable,
			networkGrantAccess: policy.network,
			budget:
				hasScript && runKind === 'script' && job.script
					? { maxIterations: 0, tokenBudget: 0, timeoutMs: job.script.timeoutMs }
					: job.budget,
			notifyOnFinish: job.notify.finished,
			...(runKind === 'script' || job.schedule.kind === 'at' || job.budget.tokenBudget === 0
				? {}
				: { dailyTokenCeiling: runsPerDay(job.schedule, now) * job.budget.tokenBudget }),
			...(runKind === 'script' || !job.model
				? {}
				: { model: `${job.model.provider}${job.model.model ? `/${job.model.model}` : ''}` }),
			warnings: [
				...(outside
					? ['The folder is outside this session’s working directory and added directories.']
					: []),
				...(networkCapable ? ['This run can reach the network.'] : []),
				...(job.permissions.browser && runKind !== 'script'
					? [
							`This run drives the browser signed in as you (profile ${job.permissions.browser.profile}) on ${Object.keys(job.permissions.browser.sites).join(', ')}.`,
						]
					: []),
			],
		}
		const reviewed = await ctx.review({
			action: verb === 'Create' ? 'create' : 'confirm',
			proposedByModel: false,
			preview,
			fullText,
		})
		return reviewed === 'create' || reviewed === 'create-paused' ? reviewed : 'cancel'
	}
	ctx.say(fullText)
	const answer = await ctx.ask({
		questionId: `schedule-confirm:${job.id}`,
		question: visibleScheduleMessage(`${verb} the scheduled job "${job.name}"? (details above)`),
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
	const say = (message: string) => ctx.say(visibleScheduleMessage(message))
	const paths = schedulePaths(ctx.home)
	const [verb, ...rest] = args
	try {
		switch (verb) {
			case undefined:
			case 'list':
				ctx.say(await listScheduleJobs(ctx))
				return
			case 'help':
				say(USAGE)
				return
			case 'confirm': {
				const job = findJob(paths, rest[0] ?? '')
				const answer = await confirmInTui(ctx, job, 'Confirm')
				if (answer === 'cancel') {
					say(`Not confirmed; ${job.name} stays ${job.state}.`)
					return
				}
				const now = new Date()
				const next = updateJob(paths, job.id, job.revision, (j) =>
					confirmJob(j, 'tui', now, { paused: answer === 'create-paused', paths }),
				)
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at: now.toISOString(),
					action: 'confirmed',
					by: 'tui',
				})
				say(`Confirmed ${next.name} (${next.state}).`)
				return
			}
			case 'pause':
			case 'resume': {
				const job = findJob(paths, rest[0] ?? '')
				if (verb === 'resume' && !confirmationHolds(job)) {
					say(`${job.name} changed since it was confirmed: /schedule confirm ${job.name}`)
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
				say(`${job.name} ${verb === 'pause' ? 'paused' : 'resumed'}.`)
				return
			}
			case 'run': {
				const job = findJob(paths, rest[0] ?? '')
				const endpoint = readEndpoint(paths.endpoint)
				const answer = endpoint
					? await callEndpoint(endpoint, 'run-now', { jobId: job.id })
					: undefined
				say(
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
				const blockedRemoval = () => {
					const state = readState(paths, job.id)
					if (!state.activeRun && !state.deliveryPending?.length) return false
					say(
						`${job.name} has a run or source result still settling. Let the scheduler finish, or use namzu schedule remove ${job.name} --force to explicitly discard a pending source result.`,
					)
					return true
				}
				if (blockedRemoval()) return
				const answer = await ctx.ask({
					questionId: `schedule-remove:${job.id}`,
					question: visibleScheduleMessage(
						`Remove the scheduled job "${job.name}"? Its history is kept.`,
					),
					options: [
						{ id: 'no', label: 'No' },
						{ id: 'yes', label: 'Remove it' },
					],
					multiSelect: false,
					allowFreeText: false,
				})
				if (answer.kind !== 'answer' || !answer.selectedOptionIds.includes('yes')) return
				if (blockedRemoval()) return
				deleteJob(paths, job.id)
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at: new Date().toISOString(),
					action: 'removed',
					by: 'operator',
				})
				say(`Removed ${job.name}.`)
				return
			}
			case 'add': {
				const parsed = parseAddArgs(rest)
				if (!parsed || !isPresetName(parsed.preset)) {
					say(
						`Usage: /schedule add <name> "<when>" <read-only|edit-in-folder> <prompt…>\nFor anything else: namzu schedule add --help`,
					)
					return
				}
				if (!ctx.model) {
					say('This session has no model yet; pick one first.')
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
						...(ctx.sourceConversation ? { delivery: ctx.sourceConversation } : {}),
					},
					{ paths, config: ctx.config, now },
				)
				const answer = await confirmInTui(ctx, job, 'Create')
				if (answer === 'cancel') {
					say('Not created.')
					return
				}
				const created = createJob(
					paths,
					confirmJob(job, 'tui', now, { paused: answer === 'create-paused', paths }),
				)
				appendHistory(paths, created.id, {
					v: 1,
					kind: 'job',
					at: now.toISOString(),
					action: 'created',
					by: 'tui',
				})
				say(`Created ${created.name} (${created.state}).`)
				return
			}
			default:
				say(USAGE)
		}
	} catch (error) {
		say(error instanceof JobRequestError || error instanceof Error ? error.message : String(error))
	}
}

export async function runLoopCommand(
	args: readonly string[],
	loops: SessionLoopScheduler,
	say: (text: string) => void,
): Promise<void> {
	const display = (message: string) => say(visibleScheduleMessage(message))
	const [first, ...rest] = args
	try {
		if (!first || first === 'list') {
			display(describeLoops(loops.list()))
			return
		}
		if (first === 'stop') {
			const id = rest[0]
			if (!id) {
				display('Usage: /loop stop <id>|all')
				return
			}
			const stopped = await loops.delete(id)
			display(
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
			display('Usage: /loop <interval> <prompt or /command>   e.g. /loop 10m check the build')
			return
		}
		const loop = await loops.create({ interval, prompt, createdBy: 'operator' })
		display(
			`↻ Loop ${loop.id}: ${loop.schedule}, between turns, for 7 days. /loop stop ${loop.id} ends it.`,
		)
	} catch (error) {
		display(error instanceof Error ? error.message : String(error))
	}
}
