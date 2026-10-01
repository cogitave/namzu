/**
 * Turning what an operator (or a confirmed model proposal) asked for into a
 * job, and what they are shown before they confirm it.
 *
 * Shared by `schedule add`, the TUI and the `schedule` tool's host, so every
 * surface refuses the same things and shows the same preview:
 *
 * - an explicit permission set is required; there is no default;
 * - `unmatched: allow` beside host execution needs `allowUnattendedHost`,
 *   which only the CLI flag sets (the tool can never);
 * - the folder is canonicalised and may not be `/`, the home directory, or
 *   anything containing or inside `NAMZU_HOME`;
 * - the token budget is nonnegative (zero is unlimited), and the wall clock is above zero;
 * - the schedule parses in the job's zone and fires at least once.
 *
 * A built job is inert (`pending-confirmation`, no trust) until
 * {@link confirmJob} records who confirmed it and on which surface.
 */

import { dirname, join } from 'node:path'
import {
	SCHEDULE_CATCH_UP_WINDOW_MS,
	type ScheduleSpec,
	countOccurrences,
	describeSchedule,
	generateScheduleJobId,
	hostTimeZone,
	installedCommandShellForDialect,
	parseScheduleSpec,
	upcomingFireTimes,
	validateTimeZone,
} from '@namzu/sdk'
import type { NamzuCliConfig } from '../config/schema.js'
import {
	PROVIDER_REGISTRY,
	type ProviderId,
	readPreferences,
} from '../integrations/providers/index.js'
import { checkJobFolder, ensureScratchFolder, plannedScratchFolder } from './folder.js'
import type { SchedulePaths } from './paths.js'
import {
	type CompiledJobPolicy,
	type PermissionInput,
	allowsCommands,
	expandPermissions,
} from './policy.js'
import { scriptShellUnavailableReason } from './script-shell.js'
import { computeProjectDigest } from './store/digest.js'
import { JOB_NAME, jobSecurityDigest } from './store/jobs.js'
import type { ConfirmationSurface, ScheduleBudget, ScheduleJob, ScheduleRunKind } from './types.js'
import { jobFormatVersion } from './types.js'

export const DEFAULT_TOKEN_BUDGET = 0
export const DEFAULT_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_MAX_ITERATIONS = 50
/** Below this many iterations a run's preview warns that it may stop unfinished. */
export const FEW_ITERATIONS = 10
/** Below this token budget a run's preview warns: one model call resends the whole prompt. */
export const FEW_TOKENS = 50_000
export const DEFAULT_WAIT_FOR_PROVIDER_MS = 10 * 60_000
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000
export const DEFAULT_KEEP_SESSIONS = 20
export const DEFAULT_PAUSE_AFTER_FAILURES = 5
/** Separate from `budget.timeoutMs`, which governs the agent phase, not the script. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 2 * 60_000
/** Q4's number: a paragraph of "what changed", independent of the notification's own cap. */
export const DEFAULT_WAKE_GATE_CONTEXT_CHARS = 4_000

export interface JobRequest {
	readonly name: string
	/** Unused (kept empty) for a pure `script` job; the agent's instruction otherwise. */
	readonly prompt: string
	readonly when: string
	/** A spec already parsed (an edit that keeps its schedule); `when` is then ignored. */
	readonly spec?: ScheduleSpec
	/** Required for project jobs. Omitted when `workspace` is `'none'`. */
	readonly folder?: string
	/** Pure scripts only. Absent keeps the existing project-folder behavior. */
	readonly workspace?: 'none'
	readonly delivery?: ScheduleJob['delivery']
	readonly deliveryWaiverRunIds?: readonly string[]
	readonly tz?: string
	readonly permissions: PermissionInput
	readonly budget?: Partial<ScheduleBudget>
	/** `provider` or `provider/model`; absent: the operator's configured primary. */
	readonly model?: string
	readonly effort?: string
	/** Enable routine Namzu desktop completion notices; defaults to true. */
	readonly notifyOnFinish?: boolean
	readonly includeSummary?: boolean
	readonly keepSessions?: number
	readonly pauseAfterFailures?: number
	readonly approvalTtlMs?: number
	readonly createdBy: ScheduleJob['createdBy']
	/** Only the CLI's `--allow-unattended-host` sets this. */
	readonly allowUnattendedHost?: boolean
	/** Absent: `'agent'`, unchanged from before this field existed. */
	readonly runKind?: ScheduleRunKind
	/** Required when `runKind` is `'script'` or `'script+agent'` (the wake-gate). */
	readonly script?: {
		readonly body: string
		readonly shell: 'bash' | 'sh'
		readonly timeoutMs?: number
		readonly report?: 'json-v1'
	}
	/** `runKind: 'script+agent'` only. */
	readonly wakeGate?: { readonly maxContextChars?: number }
}

export class JobRequestError extends Error {
	override readonly name = 'JobRequestError'
}

function positive(label: string, value: number | undefined, fallback: number): number {
	const v = value ?? fallback
	if (!Number.isSafeInteger(v) || v <= 0)
		throw new JobRequestError(`${label} must be a whole number above zero`)
	return v
}

function tokenBudget(value: number | undefined, fallback: number): number {
	const budget = value ?? fallback
	if (!Number.isSafeInteger(budget) || budget < 0)
		throw new JobRequestError(
			'the token budget must be a nonnegative whole number (0 means unlimited)',
		)
	return budget
}

/** The model a job pins: `provider[/model]`, or the configured primary. */
export function resolveJobModel(
	spec: string | undefined,
	home?: string,
): NonNullable<ScheduleJob['model']> {
	if (spec) {
		const [provider = '', ...rest] = spec.split('/')
		if (!(provider in PROVIDER_REGISTRY)) {
			throw new JobRequestError(
				`unknown provider "${provider}" (known: ${Object.keys(PROVIDER_REGISTRY).join(', ')})`,
			)
		}
		const model = rest.join('/')
		return {
			provider,
			...(model ? { model } : { model: PROVIDER_REGISTRY[provider as ProviderId].defaultModel }),
		}
	}
	const read = readPreferences(home)
	const primary = read.status === 'ok' ? read.prefs.providers[0] : undefined
	if (!primary) {
		throw new JobRequestError(
			'no provider is configured; pass --model <provider>/<model> or pick one in namzu first',
		)
	}
	return {
		provider: primary.id,
		model: primary.model ?? PROVIDER_REGISTRY[primary.id].defaultModel,
	}
}

export function buildJob(
	request: JobRequest,
	context: {
		readonly paths: SchedulePaths
		readonly config: Pick<NamzuCliConfig, 'limits'>
		readonly now: Date
		readonly osHome?: string
		/** The existing job id when rebuilding an edit. */
		readonly jobId?: string
	},
): ScheduleJob {
	if (!JOB_NAME.test(request.name)) {
		throw new JobRequestError(
			`"${request.name}" is not a job name: lowercase letters, digits and dashes, starting with a letter or digit`,
		)
	}
	const runKind = request.runKind ?? 'agent'
	if (request.workspace !== undefined && request.workspace !== 'none')
		throw new JobRequestError('workspace is none or omitted for a project job')
	if (request.workspace === 'none' && runKind !== 'script')
		throw new JobRequestError('workspace: none only applies to a pure script job')
	if (request.workspace === 'none' && request.folder !== undefined)
		throw new JobRequestError('workspace: none cannot be combined with a project folder')
	if (request.workspace === undefined && request.folder === undefined)
		throw new JobRequestError('a project folder is required unless workspace is none')
	if (runKind === 'script' && (request.model !== undefined || request.effort !== undefined)) {
		throw new JobRequestError(
			'a pure script job has no model or effort; remove --model and --effort',
		)
	}
	if (runKind === 'script' && request.prompt.trim())
		throw new JobRequestError('a pure script job has no prompt; remove the prompt')
	if (runKind === 'agent' && request.script !== undefined) {
		throw new JobRequestError('an agent job has no script; pass --kind script or script+agent')
	}
	if (request.script?.report !== undefined && request.script.report !== 'json-v1')
		throw new JobRequestError('script report is json-v1 or omitted')
	if (request.script?.report !== undefined && runKind !== 'script')
		throw new JobRequestError('script reports only apply to a pure script job')
	if (request.deliveryWaiverRunIds?.length) {
		if (request.delivery !== undefined)
			throw new JobRequestError('a source binding cannot carry delivery waivers')
		if (
			request.deliveryWaiverRunIds.length > 1_000 ||
			new Set(request.deliveryWaiverRunIds).size !== request.deliveryWaiverRunIds.length ||
			request.deliveryWaiverRunIds.some(
				(id) =>
					!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
						id,
					),
			)
		)
			throw new JobRequestError('delivery waiver run IDs are invalid')
	}
	if (runKind !== 'agent' && !request.script?.body.trim()) {
		throw new JobRequestError(
			runKind === 'script' ? 'the script is empty' : 'the wake-gate script is empty',
		)
	}
	// A pure `script` job's prompt is unused; `script+agent`'s is the agent
	// phase's instruction, needed exactly as an `agent` job's is.
	if (runKind !== 'script' && !request.prompt.trim()) {
		throw new JobRequestError('the prompt is empty')
	}
	if (request.wakeGate !== undefined && runKind !== 'script+agent') {
		throw new JobRequestError('a wake-gate only applies to a script+agent job')
	}
	// Native (non-WSL) Windows resolves the `bash` tool's shell to `cmd.exe`,
	// read only as a loose `sh`-dialect approximation — an acceptable bar for
	// a human watching a live turn, not for a whole script body confirmed
	// once and never reviewed again. WSL is unaffected: a WSL process reports
	// `platform: 'linux'`, since `__fire` there runs inside the distro.
	if (runKind !== 'agent' && process.platform === 'win32') {
		throw new JobRequestError(
			`a ${runKind} job is not supported on native Windows yet: its script would run through cmd.exe, read only as a loose approximation the floor cannot fully verify. Use WSL, where a job's script runs on the Linux side, or an agent job.`,
		)
	}
	if (
		runKind !== 'agent' &&
		request.script &&
		!installedCommandShellForDialect(request.script.shell)
	) {
		throw new JobRequestError(scriptShellUnavailableReason(request.script.shell))
	}
	const permissions = (() => {
		try {
			return expandPermissions(request.permissions)
		} catch (error) {
			throw new JobRequestError(error instanceof Error ? error.message : String(error))
		}
	})()
	if (
		permissions.unmatched === 'allow' &&
		permissions.execution === 'host' &&
		!request.allowUnattendedHost
	) {
		throw new JobRequestError(
			'unmatched: allow with execution on the host lets an unattended run do anything no rule forbids; pass --allow-unattended-host to mean it, or use --execution sandbox',
		)
	}
	if (runKind === 'script' && permissions.unmatched === 'park') {
		throw new JobRequestError(
			'a pure script job cannot use unmatched: park; nothing can wait for the operator while a script runs. Use unmatched: deny or allow (the floor and the job’s own rules still decide everything the script tries), or make this a script+agent job if a person should review something first',
		)
	}
	if (runKind !== 'agent' && permissions.execution === 'sandbox') {
		throw new JobRequestError(
			`execution: sandbox is not yet supported for a ${runKind} job's script phase; use execution: host (a follow-up may add sandboxed scripts)`,
		)
	}
	const id = context.jobId ?? generateScheduleJobId()
	const folder = (() => {
		if (request.workspace === 'none') {
			try {
				const path = plannedScratchFolder(context.paths.home, id)
				return { path, canonical: path }
			} catch (error) {
				throw new JobRequestError(
					`scratch folder cannot be planned: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		const path = request.folder as string
		const checked = checkJobFolder(path, {
			namzuHome: context.paths.home,
			...(context.osHome ? { osHome: context.osHome } : {}),
		})
		if (!checked.ok) throw new JobRequestError(checked.reason)
		return { path, canonical: checked.canonical }
	})()
	const extra = (permissions.additionalDirectories ?? []).map((dir) => {
		const checked = checkJobFolder(dir, {
			namzuHome: context.paths.home,
			...(context.osHome ? { osHome: context.osHome } : {}),
		})
		if (!checked.ok) throw new JobRequestError(`additional directory: ${checked.reason}`)
		return checked.canonical
	})
	const tz = validateTimeZone(request.tz ?? hostTimeZone())
	let spec: ScheduleSpec
	try {
		spec = request.spec ?? parseScheduleSpec(request.when, { now: context.now, tz })
	} catch (error) {
		throw new JobRequestError(error instanceof Error ? error.message : String(error))
	}
	const limits = context.config.limits ?? {}
	const budget: ScheduleBudget = {
		maxIterations: positive(
			'max iterations',
			request.budget?.maxIterations,
			limits.maxIterations || DEFAULT_MAX_ITERATIONS,
		),
		tokenBudget: tokenBudget(
			request.budget?.tokenBudget,
			limits.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
		),
		timeoutMs: positive(
			'the timeout',
			request.budget?.timeoutMs,
			limits.timeoutMs || DEFAULT_TIMEOUT_MS,
		),
		waitForProviderMs:
			request.budget?.waitForProviderMs ?? limits.waitForProviderMs ?? DEFAULT_WAIT_FOR_PROVIDER_MS,
	}
	if (budget.timeoutMs > 2_147_483_647 - 60_000)
		throw new JobRequestError('the timeout is too long')
	if (
		request.script &&
		request.script.timeoutMs !== undefined &&
		(!Number.isSafeInteger(request.script.timeoutMs) ||
			request.script.timeoutMs <= 0 ||
			request.script.timeoutMs > 2_147_483_647 - 60_000)
	) {
		throw new JobRequestError(
			'the script timeout must be a whole number of milliseconds above zero and below the timer limit',
		)
	}
	const at = context.now.toISOString()
	return {
		v: jobFormatVersion({
			runKind,
			script: request.script,
			workspace: request.workspace,
			delivery: request.delivery,
			deliveryWaiverRunIds: request.deliveryWaiverRunIds,
		}),
		kind: 'schedule-job',
		id,
		name: request.name,
		revision: 0,
		createdAt: at,
		updatedAt: at,
		createdBy: request.createdBy,
		prompt: runKind === 'script' ? '' : request.prompt,
		...(runKind !== 'agent'
			? {
					runKind,
					script: {
						body: (request.script as NonNullable<JobRequest['script']>).body,
						shell: (request.script as NonNullable<JobRequest['script']>).shell,
						timeoutMs:
							(request.script as NonNullable<JobRequest['script']>).timeoutMs ??
							DEFAULT_SCRIPT_TIMEOUT_MS,
						...(request.script?.report ? { report: request.script.report } : {}),
					},
				}
			: {}),
		...(runKind === 'script+agent'
			? {
					wakeGate: {
						maxContextChars: request.wakeGate?.maxContextChars ?? DEFAULT_WAKE_GATE_CONTEXT_CHARS,
					},
				}
			: {}),
		...(request.workspace === 'none' ? { workspace: 'none' as const } : {}),
		...(request.delivery ? { delivery: request.delivery } : {}),
		...(request.deliveryWaiverRunIds?.length
			? { deliveryWaiverRunIds: request.deliveryWaiverRunIds }
			: {}),
		folder,
		trust: null,
		schedule: spec,
		permissions: {
			...permissions,
			...(extra.length > 0 ? { additionalDirectories: extra } : {}),
		},
		budget,
		...(runKind === 'script'
			? {}
			: {
					model: {
						...resolveJobModel(request.model, context.paths.home),
						...(request.effort ? { effort: request.effort } : {}),
					},
				}),
		catchUp: { windowMs: SCHEDULE_CATCH_UP_WINDOW_MS },
		notify: {
			finished: request.notifyOnFinish ?? true,
			failed: true,
			awaitingApproval: true,
			includeSummary: request.includeSummary === true,
		},
		failurePolicy: {
			pauseAfterFailures: request.pauseAfterFailures ?? DEFAULT_PAUSE_AFTER_FAILURES,
		},
		retention: { keepSessions: request.keepSessions ?? DEFAULT_KEEP_SESSIONS },
		state: 'pending-confirmation',
		approvalTtlMs: request.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
		projectDigest: computeProjectDigest(folder.canonical),
		confirmation: null,
	}
}

/**
 * Record a confirmation: trust for the job's folder (for this job only —
 * `trust.json` is not touched), the digest of what was confirmed, and the
 * surface it happened on. A non-interactive surface confirms nothing.
 */
export function confirmJob(
	job: ScheduleJob,
	surface: ConfirmationSurface,
	now: Date,
	options: { readonly paused?: boolean; readonly paths?: SchedulePaths } = {},
): ScheduleJob {
	if (surface === 'cli-noninteractive')
		return { ...job, state: 'pending-confirmation', confirmation: null }
	if (job.workspace !== undefined && job.workspace !== 'none')
		throw new JobRequestError('the job has an unknown workspace mode')
	if (job.workspace === 'none') {
		if (job.runKind !== 'script')
			throw new JobRequestError('workspace: none only applies to a pure script job')
		const paths = options.paths
		if (!paths)
			throw new JobRequestError(
				'a no-project job needs schedule paths to confirm its scratch folder',
			)
		let expected: string
		try {
			expected = plannedScratchFolder(paths.home, job.id)
		} catch (error) {
			throw new JobRequestError(
				`scratch folder cannot be planned: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (job.folder.path !== expected || job.folder.canonical !== expected)
			throw new JobRequestError('scratch folder differs from the job id and NAMZU_HOME')
		const checked = ensureScratchFolder(paths.home, job.id)
		if (!checked.ok) throw new JobRequestError(checked.reason)
		if (checked.canonical !== expected)
			throw new JobRequestError('scratch folder resolves outside its planned path')
	}
	const at = now.toISOString()
	const trusted: ScheduleJob = {
		...job,
		trust: {
			canonical: job.folder.canonical,
			grantedAt: at,
			by: 'operator-confirmation',
		},
		projectDigest: computeProjectDigest(job.folder.canonical),
	}
	return {
		...trusted,
		state: options.paused ? 'paused' : 'active',
		...(options.paused ? { pausedAt: at, pausedBy: 'operator' as const } : {}),
		confirmation: { at, surface, digest: jobSecurityDigest(trusted) },
	}
}

/**
 * An edit: `current` with what `rebuilt` (the job built again from the
 * edited request) says, and everything that makes it the same job kept —
 * its id, name, creation, revision and state. The caller confirms it again
 * and writes it with `updateJob`, so its history carries on.
 */
export function editedJob(current: ScheduleJob, rebuilt: ScheduleJob): ScheduleJob {
	return {
		...current,
		prompt: rebuilt.prompt,
		runKind: rebuilt.runKind,
		script: rebuilt.script,
		wakeGate: rebuilt.wakeGate,
		workspace: rebuilt.workspace,
		delivery: rebuilt.delivery,
		deliveryWaiverRunIds: rebuilt.deliveryWaiverRunIds,
		folder:
			rebuilt.workspace === 'none' && rebuilt.id !== current.id
				? {
						path: join(dirname(rebuilt.folder.path), current.id),
						canonical: join(dirname(rebuilt.folder.canonical), current.id),
					}
				: rebuilt.folder,
		schedule: rebuilt.schedule,
		permissions: rebuilt.permissions,
		budget: rebuilt.budget,
		// Keep an older pure script's real (unused) model field across edits,
		// so a fresh confirmation still binds that field. New scripts omit it.
		model:
			rebuilt.runKind === 'script' && current.runKind === 'script' ? current.model : rebuilt.model,
		notify: rebuilt.notify,
		failurePolicy: rebuilt.failurePolicy,
		retention: rebuilt.retention,
		approvalTtlMs: rebuilt.approvalTtlMs,
	}
}

/** At most how many times a day the schedule fires (the busiest of the next seven days). */
export function runsPerDay(spec: ScheduleSpec, now: Date): number {
	if (spec.kind === 'at') return 1
	if (spec.kind === 'every') return Math.ceil((24 * 60 * 60_000) / spec.everyMs)
	let most = 0
	for (let d = 0; d < 7; d++) {
		const from = new Date(now.getTime() + d * 24 * 60 * 60_000)
		const to = new Date(from.getTime() + 24 * 60 * 60_000)
		most = Math.max(most, countOccurrences(spec, from, to).count)
	}
	return most
}

function duration(ms: number): string {
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
	if (ms % 60_000 === 0) return `${ms / 60_000} min`
	return `${Math.round(ms / 1000)} s`
}

/** The job as a person is asked to confirm it. Every line is computed here, never taken from a proposal. */
export function previewLines(job: ScheduleJob, policy: CompiledJobPolicy, now: Date): string[] {
	const tz = job.schedule.kind === 'cron' ? job.schedule.tz : hostTimeZone()
	const next = upcomingFireTimes(job.schedule, now, 3).map((t) =>
		new Intl.DateTimeFormat('en-GB', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: tz,
		}).format(t),
	)
	const perDay = runsPerDay(job.schedule, now)
	const hasScriptPhase = job.runKind === 'script' || job.runKind === 'script+agent'
	const networkCapable =
		policy.network ||
		(job.permissions.execution === 'host' && (hasScriptPhase || allowsCommands(job.permissions)))
	return [
		`Job         ${job.name}`,
		...(job.workspace === 'none'
			? ['Workspace   none (private scratch directory for this job)']
			: [`Folder      ${job.folder.canonical}`]),
		...(job.runKind === 'script'
			? [
					job.workspace === 'none'
						? 'Scope       private scratch directory is the script’s working directory, not a write boundary'
						: 'Scope       this folder is the script’s working directory, not a write boundary',
				]
			: []),
		`When        ${describeSchedule(job.schedule, { tz })}`,
		`Next        ${next.length > 0 ? next.join(' · ') : 'never'}`,
		`Notify      ${job.notify.finished ? 'routine completion notices enabled (rate limited)' : 'no routine completed-run notice; failures still notify'}`,
		...(job.delivery?.kind === 'source-conversation'
			? ['Results     post back to the source conversation']
			: []),
		...(job.runKind === 'script'
			? [
					'Model       none (script only)',
					`Budget      0 tokens; script timeout ${job.script ? duration(job.script.timeoutMs) : 'unknown'} per run`,
					...(job.script?.report === 'json-v1'
						? ['Report      json-v1 (structured status and scheduler-owned state)']
						: []),
				]
			: [
					`Model       ${job.model?.provider ?? '(missing)'}${job.model?.model ? `/${job.model.model}` : ''}${job.model?.effort ? ` (${job.model.effort})` : ''}`,
					`Budget      ${job.budget.tokenBudget === 0 ? 'no token limit' : `${job.budget.tokenBudget.toLocaleString('en-US')} tokens`}, ${job.budget.maxIterations} iterations, ${duration(job.budget.timeoutMs)} per run`,
				]),
		// A proposal once set 1, read as "one post per run": the first run
		// stopped after its first model call, with nothing done.
		...(job.runKind !== 'script' && job.budget.maxIterations < FEW_ITERATIONS
			? [
					`Warning     ${job.budget.maxIterations} iteration${job.budget.maxIterations === 1 ? '' : 's'} is one model call${job.budget.maxIterations === 1 ? '' : ' each'} with its tool calls; most tasks need more (the default is ${DEFAULT_MAX_ITERATIONS}), and a run that runs out stops unfinished`,
				]
			: []),
		// A proposal once set 4,000 tokens for a job whose runs each took
		// about 110,000: every model call resends the whole prompt.
		...(job.runKind !== 'script' &&
		job.budget.tokenBudget > 0 &&
		job.budget.tokenBudget < FEW_TOKENS
			? [
					`Warning     ${job.budget.tokenBudget.toLocaleString('en-US')} tokens may not cover even a few model calls, each of which resends the whole prompt; a run that runs out stops unfinished (the default has no token limit)`,
				]
			: []),
		...(job.runKind === 'script'
			? []
			: job.budget.tokenBudget === 0
				? ['Ceiling     no daily token limit']
				: [
						`Ceiling     up to ${perDay} run${perDay === 1 ? '' : 's'} a day × ${job.budget.tokenBudget.toLocaleString('en-US')} tokens = ${(perDay * job.budget.tokenBudget).toLocaleString('en-US')} tokens a day`,
					]),
		`Runs on     ${job.permissions.execution === 'host' ? 'this machine (host)' : 'the sandbox'}`,
		...(networkCapable ? ['Network     THIS RUN CAN REACH THE NETWORK'] : []),
		...(job.permissions.browser && job.runKind !== 'script'
			? [
					`Browser     SIGNED IN AS YOU: profile ${job.permissions.browser.profile}, only ${Object.keys(job.permissions.browser.sites).join(', ')}`,
				]
			: []),
		...(job.runKind !== 'script' && job.permissions.unmatched === 'allow'
			? ['Unmatched   CALLS NO RULE COVERS RUN WITHOUT ASKING']
			: []),
		...(job.runKind === 'script'
			? [
					'Script check  shell commands meet the floor and deny rules; review interpreter code yourself',
					'Permissions   allow, ask and unmatched rules below do not constrain this script',
				]
			: ['Permissions']),
		...policy.lines.map((line) => `  ${line}`),
		...(job.runKind === 'script'
			? []
			: [`Approvals   a call that waits for you expires after ${duration(job.approvalTtlMs)}`]),
	]
}
