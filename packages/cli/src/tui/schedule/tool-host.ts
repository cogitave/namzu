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

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
	type ScheduleConfirmAnswer,
	type ScheduleConfirmRequest,
	type ScheduleJobChanges,
	type ScheduleJobDraft,
	type ScheduleJobPreview,
	type ScheduleJobSummary,
	type ScheduleSpec,
	type ScheduleToolHost,
	type ScheduleUpdateRequest,
	describeSchedule,
	hostTimeZone,
	installedCommandShellForDialect,
	upcomingFireTimes,
	validateTimeZone,
} from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { discoverProviders } from '../../integrations/providers/discover.js'
import {
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_TOKEN_BUDGET,
	type JobRequest,
	JobRequestError,
	buildJob,
	confirmJob,
	editedJob,
	previewLines,
	runsPerDay,
} from '../../schedule/build.js'
import {
	changesBlock,
	changesSinceConfirmed,
	confirmationView,
	describeChanges,
	permissionsChanged,
} from '../../schedule/changes.js'
import { callsCount } from '../../schedule/fire/calls.js'
import { schedulePaths } from '../../schedule/paths.js'
import {
	type CompiledJobPolicy,
	type PermissionInput,
	allowsCommands,
	compileJobPolicy,
	compileScriptCheckPolicy,
} from '../../schedule/policy.js'
import { verifyScheduledScript } from '../../schedule/script-check.js'
import { scriptShellUnavailableReason } from '../../schedule/script-shell.js'
import { readManifest } from '../../schedule/service/manifest.js'
import { appendHistory, readHistory } from '../../schedule/store/history.js'
import {
	ScheduleConflictError,
	createJob,
	deleteJob,
	findJob,
	listJobs,
	updateJob,
} from '../../schedule/store/jobs.js'
import { nextFireOf, readState } from '../../schedule/store/state.js'
import type { ScheduleJob } from '../../schedule/types.js'
import { visibleScheduleMessage } from '../../schedule/visible-source.js'
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

/** The session's folder as a job records its own: canonical, symbolic links resolved. */
function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd)
	} catch {
		return resolve(cwd)
	}
}

/** A job as the tool reports it; `here` when it runs in the session's folder, which alone shows its prompt. */
function summary(job: ScheduleJob, here: boolean, home: string): ScheduleJobSummary {
	const tz = job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
	const state = readState(schedulePaths(home), job.id)
	return {
		name: job.name,
		folder: job.folder.canonical,
		state: job.state,
		schedule: describeSchedule(job.schedule, { tz }),
		...(nextFireOf(job, state) ? { nextFireAt: nextFireOf(job, state) } : {}),
		...(state.lastRun
			? {
					lastStatus: callsCount(state.lastRun)
						? `${state.lastRun.status} (${callsCount(state.lastRun)})`
						: state.lastRun.status,
				}
			: {}),
		...(here ? { prompt: job.prompt, inSessionFolder: true } : {}),
	}
}

async function credentialText(provider: string): Promise<string> {
	try {
		const found = (await discoverProviders({ skipProbes: true })).find(
			(d) => d.entry.id === provider,
		)
		if (!found)
			return `no ${provider} credential found here; the scheduler must find one (namzu login or daemon.env)`
		const source = found.source as {
			kind: string
			envName?: string
			path?: string
		}
		return source.kind === 'env'
			? `environment variable ${source.envName ?? ''} (a service does not see your shell's variables)`
			: `${source.kind}${source.path ? ` (${source.path})` : ''}`
	} catch {
		return 'unknown'
	}
}

/** The preview lines, the credential, the warnings, and the full prompt with hidden characters shown. */
function confirmationBody(
	p: ScheduleJobPreview,
	findings: readonly string[],
	lines: readonly string[],
): string[] {
	const scriptSection =
		p.runKind && p.runKind !== 'agent' && p.script
			? [
					`${p.runKind === 'script' ? 'Script' : 'Wake-gate script'} (exactly as it will run, ${p.script.shell}; verified against the scheduled-run floor and any deny rules)`,
					...p.script.body.split('\n').map((l) => `  │ ${l}`),
					p.runKind === 'script'
						? 'Runs exactly as shown; the scheduled-run floor and every deny rule apply to this script'
						: 'Runs exactly as shown; the scheduled-run floor and every deny rule apply to the gate, and the permission set governs the agent phase',
				]
			: []
	const promptSection = p.prompt.trim()
		? [
				p.runKind === 'script+agent'
					? 'Prompt (used only when the wake-gate says wake: true)'
					: 'Prompt (exactly as the run will read it)',
				...p.prompt.split('\n').map((l) => `  │ ${l}`),
			]
		: []
	return [
		...lines,
		...(p.runKind === 'script' ? [] : [`Credential  ${p.credentialSource ?? 'unknown'}`]),
		...p.warnings.map((w) => `Warning     ${w}`),
		...findings.map((f) => `Warning     ${f}`),
		...scriptSection,
		...promptSection,
	]
}

/** The preview lines, the full prompt with hidden characters shown, and the tripwire's findings. */
export function renderConfirmation(
	request: ScheduleConfirmRequest,
	lines: readonly string[],
): string {
	return visibleScheduleMessage(
		[
			'⏲ PROPOSED BY THE MODEL, NOT BY YOU — a scheduled job that runs later with nobody watching.',
			...confirmationBody(request.preview, request.promptFindings, lines),
		].join('\n'),
	)
}

/**
 * A change the model proposed: what changes first (`-`/`+` lines, as
 * `schedule edit` shows them), a warning when the permissions change, then
 * the job as it would run, whole.
 */
export function renderUpdateConfirmation(
	request: ScheduleUpdateRequest,
	lines: readonly string[],
): string {
	return visibleScheduleMessage(
		[
			`⏲ PROPOSED BY THE MODEL, NOT BY YOU — a change to the scheduled job ${request.preview.name}, which runs later with nobody watching.`,
			...changesBlock(request.changes),
			...(request.permissionsChange
				? [
						'Warning     THE PERMISSIONS CHANGE: from its next run the job may do what the rules below allow.',
					]
				: []),
			...confirmationBody(request.preview, request.promptFindings, lines),
		].join('\n'),
	)
}

/**
 * The request `buildJob` rebuilds a job from, for a change the model
 * proposed: every field it left out as the job has it. A new permission set
 * keeps the job's `execution` unless it names one, and the job's additional
 * directories (which only the operator sets).
 */
export function updateRequest(
	current: ScheduleJob,
	changes: ScheduleJobChanges,
	cwd: string,
	fallbackModel?: { readonly provider: string; readonly model?: string },
): JobRequest {
	const cron = current.schedule.kind === 'cron' ? current.schedule : undefined
	let spec: ScheduleSpec | undefined
	if (changes.when === undefined) {
		if (changes.tz === undefined) spec = current.schedule
		else if (cron) spec = { ...cron, tz: validateTimeZone(changes.tz) }
		else
			throw new JobRequestError(
				`a time zone changes only a cron schedule, and "${current.name}" is not one; give when as well.`,
			)
	}
	const tz = changes.tz ?? cron?.tz
	const dirs = current.permissions.additionalDirectories
	const kept = dirs && dirs.length > 0 ? { additionalDirectories: [...dirs] } : {}
	const proposed = changes.permissions
	const permissions: PermissionInput = proposed
		? {
				...(proposed.preset ? { preset: proposed.preset } : {}),
				...(proposed.rules ? { rules: proposed.rules } : {}),
				unmatched: proposed.unmatched,
				execution: proposed.execution ?? current.permissions.execution,
				...kept,
				...(proposed.browser ? { browser: proposed.browser } : {}),
			}
		: {
				rules: current.permissions.rules,
				unmatched: current.permissions.unmatched,
				execution: current.permissions.execution,
				...kept,
				...(current.permissions.browser ? { browser: current.permissions.browser } : {}),
			}
	// A kind or script the tool did not touch carries the job's own forward
	// unchanged, exactly as `editedJob` does for a terminal edit. Moving TO
	// `'agent'` always drops the script — whether or not one was given here,
	// since an agent job cannot carry one (`buildJob` refuses that
	// combination outright) — and the wake-gate cap only ever applies to a
	// `runKind` that stays (or becomes) `'script+agent'`.
	const runKind = changes.runKind ?? current.runKind
	if (runKind === 'script' && changes.prompt !== undefined)
		throw new JobRequestError('a pure script job has no prompt; remove prompt')
	if (runKind === 'script' && changes.budget !== undefined)
		throw new JobRequestError(
			'a pure script job has no agent budget; remove budget and use script.timeoutMs for its timeout',
		)
	if (
		runKind === 'script' &&
		permissions.browser &&
		(current.runKind !== 'script' || changes.permissions !== undefined)
	)
		throw new JobRequestError(
			'a pure script job cannot use a browser grant; remove permissions.browser',
		)
	const script = runKind === 'agent' ? undefined : (changes.script ?? current.script)
	return {
		name: current.name,
		prompt: runKind === 'script' ? '' : (changes.prompt ?? current.prompt),
		when: changes.when ?? '',
		...(spec ? { spec } : {}),
		folder: changes.folder !== undefined ? resolve(cwd, changes.folder) : current.folder.path,
		...(tz ? { tz } : {}),
		...(runKind ? { runKind } : {}),
		...(script ? { script } : {}),
		...(runKind === 'script+agent' && current.wakeGate ? { wakeGate: current.wakeGate } : {}),
		permissions,
		budget: { ...current.budget, ...(changes.budget ?? {}) },
		...(runKind === 'script'
			? {}
			: current.model
				? {
						model: `${current.model.provider}${current.model.model ? `/${current.model.model}` : ''}`,
						...(current.model.effort ? { effort: current.model.effort } : {}),
					}
				: fallbackModel
					? {
							model: `${fallbackModel.provider}${fallbackModel.model ? `/${fallbackModel.model}` : ''}`,
						}
					: {}),
		includeSummary: current.notify.includeSummary,
		keepSessions: current.retention.keepSessions,
		pauseAfterFailures: current.failurePolicy.pauseAfterFailures,
		approvalTtlMs: current.approvalTtlMs,
		createdBy: current.createdBy,
		// `unmatched: allow` on the host is the operator's choice
		// (`--allow-unattended-host`); a change that keeps the permissions
		// keeps it, and the tool can never propose it.
		allowUnattendedHost: proposed === undefined && current.permissions.unmatched === 'allow',
	}
}

/**
 * Each optional value the model set to something other than what the
 * operator would get by leaving it out, in words. Models fill optional fields
 * in: one proposal set the time zone to America/New_York on a machine in
 * Istanbul and ran commands in the sandbox, which nobody had asked for.
 */
export function chosenByTheModel(
	draft: ScheduleJobDraft,
	job: ScheduleJob,
	cwd: string,
	config: Pick<NamzuCliConfig, 'limits'>,
): string[] {
	const zone = hostTimeZone()
	const limits = config.limits ?? {}
	const out: string[] = []
	if (draft.tz !== undefined && draft.tz !== zone)
		out.push(`time zone ${draft.tz}, not this machine's ${zone}`)
	const session = resolve(cwd)
	if (draft.folder !== undefined && resolve(session, draft.folder) !== session)
		out.push(`folder ${job.folder.canonical}, not this session's`)
	if (draft.permissions.execution === 'sandbox')
		out.push('commands run in the sandbox; the default is this machine')
	const iterations = limits.maxIterations || DEFAULT_MAX_ITERATIONS
	if (draft.budget?.maxIterations !== undefined && draft.budget.maxIterations !== iterations)
		out.push(`${draft.budget.maxIterations} iterations per run (the default is ${iterations})`)
	const tokens = limits.tokenBudget || DEFAULT_TOKEN_BUDGET
	if (draft.budget?.tokenBudget !== undefined && draft.budget.tokenBudget !== tokens)
		out.push(
			`${draft.budget.tokenBudget.toLocaleString('en-US')} tokens per run (the default is ${tokens.toLocaleString('en-US')})`,
		)
	const timeout = limits.timeoutMs || DEFAULT_TIMEOUT_MS
	if (draft.budget?.timeoutMs !== undefined && draft.budget.timeoutMs !== timeout)
		out.push(
			`${Math.round(draft.budget.timeoutMs / 1000)} s per run (the default is ${Math.round(timeout / 60_000)} min)`,
		)
	if (draft.permissions.browser?.headed) out.push('a visible browser window during each run')
	return out
}

export function createScheduleToolHost(ui: ScheduleUi): ScheduleToolHost {
	const built = new WeakMap<ScheduleJobPreview, { job: ScheduleJob; lines: string[] }>()
	const proposedUpdates = new WeakMap<
		ScheduleJobPreview,
		{
			readonly current: ScheduleJob
			readonly job: ScheduleJob
			readonly lines: string[]
			readonly changes: string[]
		}
	>()
	/** What the person is shown for a job, every field computed here; `extra` warnings last. */
	const previewOf = async (
		job: ScheduleJob,
		extra: readonly string[],
		now: Date,
	): Promise<{ preview: ScheduleJobPreview; policy: CompiledJobPolicy }> => {
		const layers = readPermissionLayers({ cwd: job.folder.canonical })
		const policy = compileJobPolicy(job.permissions, {
			layers,
			namzuHome: ui.home(),
			folder: job.folder,
		})
		if (policy.diagnostics.length > 0)
			throw new Error(`The rules do not compile: ${policy.diagnostics.join('; ')}`)
		if (job.runKind && job.runKind !== 'agent' && !job.script)
			throw new Error(`The ${job.runKind} job has no script to preview.`)
		// A model-proposed script/wake-gate gets the same static check
		// `schedule add` runs before anything is shown, so a proposal the
		// floor or a `deny` rule refuses never reaches this confirmation
		// screen at all.
		if (job.runKind && job.runKind !== 'agent' && job.script) {
			const selectedShell = installedCommandShellForDialect(job.script.shell)
			if (!selectedShell) throw new Error(scriptShellUnavailableReason(job.script.shell))
			const scriptPolicy = compileScriptCheckPolicy(job.permissions, {
				layers,
				namzuHome: ui.home(),
				folder: job.folder,
			})
			const checked = verifyScheduledScript(job.script.body, selectedShell.dialect, scriptPolicy)
			if (!checked.ok) {
				throw new Error(
					`The ${job.runKind === 'script' ? 'script' : 'wake-gate script'} was refused: ${checked.reason}`,
				)
			}
		}
		const roots = [ui.cwd(), ...ui.extraRoots()]
		const outside = !roots.some((root) => within(root, job.folder.canonical))
		const perDay = runsPerDay(job.schedule, now)
		const hasScriptPhase = job.runKind === 'script' || job.runKind === 'script+agent'
		const networkCapable =
			policy.network ||
			(job.permissions.execution === 'host' && (hasScriptPhase || allowsCommands(job.permissions)))
		const warnings = [
			...(outside
				? ['The folder is outside this session’s working directory and added directories.']
				: []),
			...(networkCapable ? ['This run can reach the network.'] : []),
			...(job.permissions.browser && job.runKind !== 'script'
				? [
						`This run drives the browser signed in as you (profile ${job.permissions.browser.profile}) on ${Object.keys(job.permissions.browser.sites).join(', ')}.`,
					]
				: []),
			...extra,
		]
		const preview: ScheduleJobPreview = {
			name: job.name,
			folder: job.folder.canonical,
			outsideSessionRoots: outside,
			prompt: job.prompt,
			...(job.runKind && job.runKind !== 'agent' ? { runKind: job.runKind } : {}),
			...(job.script ? { script: job.script } : {}),
			schedule: describeSchedule(job.schedule, {
				tz: job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone(),
			}),
			nextFireTimes: upcomingFireTimes(job.schedule, now, 3).map((t) => t.toISOString()),
			rules: policy.lines,
			unmatched: job.permissions.unmatched,
			execution: job.permissions.execution,
			networkAccess: networkCapable,
			networkGrantAccess: policy.network,
			budget:
				job.runKind === 'script' && job.script
					? {
							maxIterations: 0,
							tokenBudget: 0,
							timeoutMs: job.script.timeoutMs,
						}
					: {
							maxIterations: job.budget.maxIterations,
							tokenBudget: job.budget.tokenBudget,
							timeoutMs: job.budget.timeoutMs,
						},
			...(job.runKind === 'script' || job.schedule.kind === 'at'
				? {}
				: { dailyTokenCeiling: perDay * job.budget.tokenBudget }),
			...(job.runKind === 'script' || !job.model
				? {}
				: {
						model: `${job.model.provider}${job.model.model ? `/${job.model.model}` : ''}`,
						credentialSource: await credentialText(job.model.provider),
					}),
			warnings,
		}
		return { preview, policy }
	}
	const NOT_INSTALLED_NOTE =
		'No scheduler is installed on this machine, so the job does not run until the operator runs `namzu schedule install`. Tell them; do not say it will run.'
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
		// The job stores the grant, the fire enforces it, and the
		// confirmation shows it line by line, so the model may propose one.
		browserGrants: true,
		async preview(draft: ScheduleJobDraft): Promise<ScheduleJobPreview> {
			if (draft.runKind === 'script' && draft.budget !== undefined)
				throw new JobRequestError(
					'a pure script job has no agent budget; remove budget and use script.timeoutMs for its timeout',
				)
			if (draft.runKind === 'script' && draft.permissions.browser !== undefined)
				throw new JobRequestError(
					'a pure script job cannot use a browser grant; remove permissions.browser',
				)
			const model = ui.model()
			if (!model && draft.runKind !== 'script')
				throw new Error('This session has no model; a scheduled job runs on the session’s model.')
			const now = new Date()
			const folder = resolve(ui.cwd(), draft.folder ?? '.')
			const job = buildJob(
				{
					name: draft.name,
					prompt: draft.prompt ?? '',
					when: draft.when,
					folder,
					...(draft.runKind ? { runKind: draft.runKind } : {}),
					...(draft.script ? { script: draft.script } : {}),
					...(draft.tz ? { tz: draft.tz } : {}),
					permissions: {
						...(draft.permissions.preset ? { preset: draft.permissions.preset } : {}),
						...(draft.permissions.rules ? { rules: draft.permissions.rules } : {}),
						unmatched: draft.permissions.unmatched,
						...(draft.permissions.execution ? { execution: draft.permissions.execution } : {}),
						...(draft.permissions.browser ? { browser: draft.permissions.browser } : {}),
					},
					...(draft.budget ? { budget: draft.budget } : {}),
					...(model && draft.runKind !== 'script'
						? {
								model: `${model.provider}${model.model ? `/${model.model}` : ''}`,
							}
						: {}),
					createdBy: {
						surface: 'tool',
						...(ui.sessionId() ? { sessionId: ui.sessionId() as string } : {}),
					},
				},
				{ paths: paths(), config: ui.config(), now },
			)
			const chosen = chosenByTheModel(draft, job, ui.cwd(), ui.config()).map(
				(line) => `Chosen by the model, not the default: ${line}`,
			)
			const { preview, policy } = await previewOf(job, chosen, now)
			built.set(preview, { job, lines: previewLines(job, policy, now) })
			return preview
		},

		async confirm(
			request: ScheduleConfirmRequest,
			signal?: AbortSignal,
		): Promise<ScheduleConfirmAnswer> {
			const entry = built.get(request.preview)
			if (!entry) return 'cancel'
			ui.say(renderConfirmation(request, entry.lines))
			const answer = await ui.ask(
				{
					questionId: `schedule:${entry.job.id}`,
					question: visibleScheduleMessage(
						`Create the scheduled job "${entry.job.name}" the model proposed? (details above)`,
					),
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
				},
				signal,
			)
			if (answer.kind !== 'answer') return 'cancel'
			const id = answer.selectedOptionIds[0]
			return id === 'create' || id === 'create-paused' ? id : 'cancel'
		},

		async create(_draft, preview, options) {
			const entry = built.get(preview)
			if (!entry) throw new Error('That proposal is no longer current; propose it again.')
			const job = createJob(
				paths(),
				confirmJob(entry.job, 'tool-confirmed', new Date(), {
					paused: options.paused,
				}),
			)
			history(job, 'created')
			// A job with no scheduler to run it does nothing, and the model's
			// "done" said nothing about that.
			const installed = readManifest(paths()) !== undefined
			ui.say(
				`⏲ Scheduled job ${job.name} created${options.paused ? ' (paused)' : ''}. /schedule lists it.${installed ? '' : ' The scheduler is not installed, so it does not run until you install it: namzu schedule install.'}`,
			)
			return {
				name: job.name,
				...(installed ? {} : { note: NOT_INSTALLED_NOTE }),
			}
		},

		// A change is confirmed like a new job, whole, with what changes
		// above it, and saved to the same job: its id, name and history stay.
		// Every field it can touch is in the confirmation's digest, so the
		// saved job carries the operator's new confirmation, as an edit on a
		// terminal does.
		async previewUpdate(ref: string, changes: ScheduleJobChanges) {
			const current = findJob(paths(), ref)
			const now = new Date()
			const job = editedJob(
				current,
				buildJob(updateRequest(current, changes, ui.cwd(), ui.model()), {
					paths: paths(),
					config: ui.config(),
					now,
				}),
			)
			const { preview, policy } = await previewOf(job, [], now)
			const view = (j: ScheduleJob) =>
				confirmationView(
					j,
					compileJobPolicy(j.permissions, {
						layers: readPermissionLayers({ cwd: j.folder.canonical }),
						namzuHome: ui.home(),
						folder: j.folder,
					}),
					now,
				)
			const differs = describeChanges(view(current), view(job))
			if (differs.length === 0) throw new Error(`That changes nothing in "${current.name}".`)
			const lines = [...changesSinceConfirmed(readHistory(paths(), current.id)), ...differs]
			proposedUpdates.set(preview, {
				current,
				job,
				lines: previewLines(job, policy, now),
				changes: lines,
			})
			return {
				preview,
				changes: lines,
				permissionsChange: permissionsChanged(current, job),
			}
		},

		async confirmUpdate(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<boolean> {
			const entry = proposedUpdates.get(request.preview)
			if (!entry) return false
			ui.say(renderUpdateConfirmation(request, entry.lines))
			const answer = await ui.ask(
				{
					questionId: `schedule-update:${entry.current.id}`,
					question: visibleScheduleMessage(
						`Save the change the model proposed to the scheduled job "${entry.current.name}"? (details above)`,
					),
					header: 'Proposed by the model',
					options: [
						{ id: 'cancel', label: 'Cancel', description: 'Change nothing' },
						{
							id: 'save',
							label: 'Save',
							description: request.permissionsChange
								? 'It keeps its history and runs under the new permissions above'
								: 'It keeps its history and runs as shown above',
						},
					],
					multiSelect: false,
					allowFreeText: false,
				},
				signal,
			)
			return answer.kind === 'answer' && answer.selectedOptionIds[0] === 'save'
		},

		async update(preview: ScheduleJobPreview) {
			const entry = proposedUpdates.get(preview)
			if (!entry) throw new Error('That proposal is no longer current; propose it again.')
			const now = new Date()
			let next: ScheduleJob
			try {
				next = updateJob(paths(), entry.current.id, entry.current.revision, () =>
					confirmJob(entry.job, 'tool-confirmed', now, {
						paused: entry.current.state === 'paused',
					}),
				)
			} catch (error) {
				if (error instanceof ScheduleConflictError)
					throw new Error(
						`"${entry.current.name}" changed while the operator was being asked; propose the change again.`,
					)
				throw error
			}
			proposedUpdates.delete(preview)
			appendHistory(paths(), next.id, {
				v: 1,
				kind: 'job',
				at: now.toISOString(),
				action: 'edited',
				by: 'tool',
				changes: entry.changes,
			})
			const installed = readManifest(paths()) !== undefined
			ui.say(
				`⏲ Scheduled job ${next.name} changed (${next.state}); it keeps its history. /schedule shows it.${installed ? '' : ' The scheduler is not installed, so it does not run until you install it: namzu schedule install.'}`,
			)
			return {
				name: next.name,
				...(installed ? {} : { note: NOT_INSTALLED_NOTE }),
			}
		},

		// Every job, whatever `allFolders` says: a model that has just created
		// a job in another folder, and does not pass `allFolders`, was told
		// "No scheduled jobs." while `namzu schedule list` showed it. The
		// session folder's are marked, and only theirs carry the prompt.
		async list() {
			const cwd = canonicalCwd(ui.cwd())
			const { jobs, errors } = listJobs(paths())
			if (errors.length > 0)
				throw new Error(
					`${errors.length} job file${errors.length === 1 ? '' : 's'} could not be read; inspect or repair the files under NAMZU_HOME before listing scheduled jobs.`,
				)
			return jobs.map((job) => summary(job, job.folder.canonical === cwd, ui.home()))
		},

		async find(ref) {
			try {
				const job = findJob(paths(), ref)
				return summary(job, job.folder.canonical === canonicalCwd(ui.cwd()), ui.home())
			} catch {
				return undefined
			}
		},

		async confirmAction(job, action, signal) {
			const answer = await ui.ask(
				{
					questionId: `schedule-${action}:${job.name}`,
					question: visibleScheduleMessage(
						`${action === 'delete' ? 'Delete' : 'Resume'} the scheduled job "${job.name}" (${job.schedule}, in ${job.folder})? The model asked.`,
					),
					header: 'Proposed by the model',
					options: [
						{ id: 'no', label: 'No', description: 'Leave it as it is' },
						{
							id: 'yes',
							label: action === 'delete' ? 'Delete it' : 'Resume it',
							description: '',
						},
					],
					multiSelect: false,
					allowFreeText: false,
				},
				signal,
			)
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
