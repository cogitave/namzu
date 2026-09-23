/**
 * The TUI's side of the `schedule` tool: it computes everything the person
 * confirming is shown — from the job the CLI would build, never from the
 * model's words — and asks on the terminal.
 *
 * The confirmation is the TUI's own question, answered with a keypress:
 * "Cancel" is the first (default) choice, and nothing but "Create" or
 * "Create paused" creates a job. A job created here records
 * `confirmation.surface: tool-confirmed`.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import {
	type ScheduleConfirmAnswer,
	type ScheduleConfirmRequest,
	type ScheduleJobDraft,
	type ScheduleJobPreview,
	type ScheduleJobSummary,
	type ScheduleToolHost,
	describeSchedule,
	hostTimeZone,
	revealHiddenCharacters,
	upcomingFireTimes,
} from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { discoverProviders } from '../../integrations/providers/discover.js'
import { buildJob, confirmJob, previewLines, runsPerDay } from '../../schedule/build.js'
import { schedulePaths } from '../../schedule/paths.js'
import { compileJobPolicy } from '../../schedule/policy.js'
import { appendHistory } from '../../schedule/store/history.js'
import { createJob, deleteJob, findJob, listJobs, updateJob } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import type { ScheduleJob } from '../../schedule/types.js'
import type { QuestionFn } from '../agent.js'

export interface ScheduleUi {
	/** `NAMZU_HOME`. */
	readonly home: () => string
	/** The session's working directory. */
	readonly cwd: () => string
	/** Directories besides the working directory the session's tools reach. */
	readonly extraRoots: () => readonly string[]
	/** The session's model; a proposed job runs on it. */
	readonly model: () => { readonly provider: string; readonly model?: string } | undefined
	readonly config: () => Pick<NamzuCliConfig, 'limits'>
	readonly sessionId: () => string | undefined
	/** Show a system line in the transcript. */
	readonly say: (text: string) => void
	/** Ask the person on the terminal. */
	readonly ask: QuestionFn
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function summary(job: ScheduleJob, withPrompt: boolean, home: string): ScheduleJobSummary {
	const tz = job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
	const state = readState(schedulePaths(home), job.id)
	return {
		name: job.name,
		folder: job.folder.canonical,
		state: job.state,
		schedule: describeSchedule(job.schedule, { tz }),
		...(state.nextFireAt && job.state === 'active' ? { nextFireAt: state.nextFireAt } : {}),
		...(state.lastRun ? { lastStatus: state.lastRun.status } : {}),
		...(withPrompt ? { prompt: job.prompt } : {}),
	}
}

async function credentialText(provider: string): Promise<string> {
	try {
		const found = (await discoverProviders({ skipProbes: true })).find(
			(d) => d.entry.id === provider,
		)
		if (!found)
			return `no ${provider} credential found here; the scheduler must find one (namzu login or daemon.env)`
		const source = found.source as { kind: string; envName?: string; path?: string }
		return source.kind === 'env'
			? `environment variable ${source.envName ?? ''} (a service does not see your shell's variables)`
			: `${source.kind}${source.path ? ` (${source.path})` : ''}`
	} catch {
		return 'unknown'
	}
}

/** The preview lines, the full prompt with hidden characters shown, and the tripwire's findings. */
export function renderConfirmation(
	request: ScheduleConfirmRequest,
	lines: readonly string[],
): string {
	const p = request.preview
	return [
		'⏲ PROPOSED BY THE MODEL, NOT BY YOU — a scheduled job that runs later with nobody watching.',
		...lines,
		`Credential  ${p.credentialSource ?? 'unknown'}`,
		...p.warnings.map((w) => `Warning     ${w}`),
		...request.promptFindings.map((f) => `Warning     ${f}`),
		'Prompt (exactly as the run will read it)',
		...revealHiddenCharacters(p.prompt)
			.split('\n')
			.map((l) => `  │ ${l}`),
	].join('\n')
}

export function createScheduleToolHost(ui: ScheduleUi): ScheduleToolHost {
	const built = new WeakMap<ScheduleJobPreview, { job: ScheduleJob; lines: string[] }>()
	const paths = () => schedulePaths(ui.home())
	const history = (job: ScheduleJob, action: 'created' | 'paused' | 'resumed' | 'removed') =>
		appendHistory(paths(), job.id, {
			v: 1,
			kind: 'job',
			at: new Date().toISOString(),
			action,
			by: 'tool',
		})
	return {
		async preview(draft: ScheduleJobDraft): Promise<ScheduleJobPreview> {
			const model = ui.model()
			if (!model)
				throw new Error('This session has no model; a scheduled job runs on the session’s model.')
			const now = new Date()
			const folder = resolve(ui.cwd(), draft.folder ?? '.')
			const job = buildJob(
				{
					name: draft.name,
					prompt: draft.prompt,
					when: draft.when,
					folder,
					...(draft.tz ? { tz: draft.tz } : {}),
					permissions: {
						...(draft.permissions.preset ? { preset: draft.permissions.preset } : {}),
						...(draft.permissions.rules ? { rules: draft.permissions.rules } : {}),
						unmatched: draft.permissions.unmatched,
						...(draft.permissions.execution ? { execution: draft.permissions.execution } : {}),
					},
					...(draft.budget ? { budget: draft.budget } : {}),
					model: `${model.provider}${model.model ? `/${model.model}` : ''}`,
					createdBy: {
						surface: 'tool',
						...(ui.sessionId() ? { sessionId: ui.sessionId() as string } : {}),
					},
				},
				{ paths: paths(), config: ui.config(), now },
			)
			const policy = compileJobPolicy(job.permissions, {
				layers: readPermissionLayers({ cwd: job.folder.canonical }),
				namzuHome: ui.home(),
			})
			if (policy.diagnostics.length > 0)
				throw new Error(`The rules do not compile: ${policy.diagnostics.join('; ')}`)
			const roots = [ui.cwd(), ...ui.extraRoots()]
			const outside = !roots.some((root) => within(root, job.folder.canonical))
			const perDay = runsPerDay(job.schedule, now)
			const warnings = [
				...(outside
					? ['The folder is outside this session’s working directory and added directories.']
					: []),
				...(policy.network ? ['This run can reach the network.'] : []),
			]
			const preview: ScheduleJobPreview = {
				name: job.name,
				folder: job.folder.canonical,
				outsideSessionRoots: outside,
				prompt: job.prompt,
				schedule: describeSchedule(job.schedule, {
					tz: job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone(),
				}),
				nextFireTimes: upcomingFireTimes(job.schedule, now, 3).map((t) => t.toISOString()),
				rules: policy.lines,
				unmatched: job.permissions.unmatched,
				execution: job.permissions.execution,
				networkAccess: policy.network,
				budget: {
					maxIterations: job.budget.maxIterations,
					tokenBudget: job.budget.tokenBudget,
					timeoutMs: job.budget.timeoutMs,
				},
				...(job.schedule.kind === 'at'
					? {}
					: { dailyTokenCeiling: perDay * job.budget.tokenBudget }),
				model: `${job.model.provider}${job.model.model ? `/${job.model.model}` : ''}`,
				credentialSource: await credentialText(job.model.provider),
				warnings,
			}
			built.set(preview, { job, lines: previewLines(job, policy, now) })
			return preview
		},

		async confirm(request: ScheduleConfirmRequest): Promise<ScheduleConfirmAnswer> {
			const entry = built.get(request.preview)
			if (!entry) return 'cancel'
			ui.say(renderConfirmation(request, entry.lines))
			const answer = await ui.ask({
				questionId: `schedule:${entry.job.id}`,
				question: `Create the scheduled job "${entry.job.name}" the model proposed? (details above)`,
				header: 'Proposed by the model',
				options: [
					{ id: 'cancel', label: 'Cancel', description: 'Create nothing' },
					{
						id: 'create-paused',
						label: 'Create paused',
						description: 'Create it, but do not run it until /schedule resume',
					},
					{
						id: 'create',
						label: 'Create',
						description: 'It runs on schedule with the permissions above',
					},
				],
				multiSelect: false,
				allowFreeText: false,
			})
			if (answer.kind !== 'answer') return 'cancel'
			const id = answer.selectedOptionIds[0]
			return id === 'create' || id === 'create-paused' ? id : 'cancel'
		},

		async create(_draft, preview, options) {
			const entry = built.get(preview)
			if (!entry) throw new Error('That proposal is no longer current; propose it again.')
			const job = createJob(
				paths(),
				confirmJob(entry.job, 'tool-confirmed', new Date(), { paused: options.paused }),
			)
			history(job, 'created')
			ui.say(
				`⏲ Scheduled job ${job.name} created${options.paused ? ' (paused)' : ''}. /schedule lists it.`,
			)
			return { name: job.name }
		},

		async list(options) {
			const cwd = ui.cwd()
			return listJobs(paths())
				.jobs.filter((job) => options.allFolders || job.folder.canonical === cwd)
				.map((job) => summary(job, job.folder.canonical === cwd, ui.home()))
		},

		async find(ref) {
			try {
				const job = findJob(paths(), ref)
				return summary(job, job.folder.canonical === ui.cwd(), ui.home())
			} catch {
				return undefined
			}
		},

		async confirmAction(job, action) {
			const answer = await ui.ask({
				questionId: `schedule-${action}:${job.name}`,
				question: `${action === 'delete' ? 'Delete' : 'Resume'} the scheduled job "${job.name}" (${job.schedule}, in ${job.folder})? The model asked.`,
				header: 'Proposed by the model',
				options: [
					{ id: 'no', label: 'No', description: 'Leave it as it is' },
					{ id: 'yes', label: action === 'delete' ? 'Delete it' : 'Resume it', description: '' },
				],
				multiSelect: false,
				allowFreeText: false,
			})
			return answer.kind === 'answer' && answer.selectedOptionIds.includes('yes')
		},

		async pause(ref) {
			const job = findJob(paths(), ref)
			updateJob(paths(), job.id, job.revision, (j) => ({
				...j,
				state: 'paused',
				pausedAt: new Date().toISOString(),
				pausedBy: 'tool',
			}))
			history(job, 'paused')
			ui.say(
				`⏲ The model paused the scheduled job ${job.name}. /schedule resume ${job.name} starts it again.`,
			)
		},

		async resume(ref) {
			const job = findJob(paths(), ref)
			updateJob(paths(), job.id, job.revision, (j) => ({
				...j,
				state: 'active',
				pausedAt: undefined,
				pausedBy: undefined,
			}))
			history(job, 'resumed')
		},

		async delete(ref) {
			const job = findJob(paths(), ref)
			deleteJob(paths(), job.id)
			history(job, 'removed')
		},
	}
}
