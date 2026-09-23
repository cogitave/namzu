/**
 * `/resume` of a scheduled run parked on a decision, or on a tool's request
 * for a person.
 *
 * The parked batch is put to the operator with the ordinary permission
 * screen. Their answer is applied to exactly that batch (`pendingDecision`,
 * the model is not asked again); calls later in the turn are asked of them
 * live; and the resumed turn is gated by the JOB's rules, recompiled now
 * from the job, not by the folder config the TUI session was built with. The
 * operator's own mode can only make it stricter.
 *
 * The resumed turn runs on the job's provider and model, not the session's.
 *
 * What the rules cannot carry, the TUI session must already match: the
 * resumed turn runs in THIS session's sandbox (or none), working directory
 * and extra roots, so a session whose execution or roots differ from the
 * job's is refused with the command that opens a matching one. And the
 * screen offers no "allow all": a scheduled run has no session-wide approval.
 *
 * A run a tool paused for a person (`ToolResult.handoff`) has no batch to
 * approve. The operator is shown what the tool asked for and chooses to
 * continue it — the next step is a model call, under the job's rules — or to
 * abandon it.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	DECLINED_TOOL_CALL_FEEDBACK,
	DiskSessionLog,
	type HITLResumeDecision,
	SessionPaths,
	asSessionId,
	findPendingCheckpoint,
	hostTimeZone,
} from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { PermissionMode } from '../../permissions/mode.js'
import { schedulePaths } from '../../schedule/paths.js'
import { allowsCommands, compileJobPolicy } from '../../schedule/policy.js'
import { resumeCommand } from '../../schedule/resume-command.js'
import { listJobs } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import type { ScheduleJob } from '../../schedule/types.js'
import type { PermissionFn, QuestionFn, ResumePausedParams, ScreenPermissionFn } from '../agent.js'
import { terminalDisplayText } from '../terminal-display.js'
import { handoffContinuationNote } from '../turn-interruption.js'

export interface ScheduledPark {
	readonly job: ScheduleJob
	readonly runId: string
	readonly turnId: string
	/**
	 * The provider and model the job's run uses: the job's pin, with the
	 * model its turn recorded when the job names only a provider.
	 */
	readonly model: { readonly provider: string; readonly model?: string; readonly effort?: string }
	/** The parked batch; empty for a handoff park, which has none. */
	readonly toolCalls: Extract<
		NonNullable<Awaited<ReturnType<typeof findPendingCheckpoint>>>['pending']['request'],
		{ type: 'tool_review' }
	>['toolCalls']
	/** Present when a tool asked for a person instead of a batch waiting for approval. */
	readonly handoff?: ScheduledHandoff
}

export interface ScheduledHandoff {
	readonly reason: string
	readonly detail?: Readonly<Record<string, string>>
}

/** The job whose run is parked in this session, and the batch it waits on. */
export async function findScheduledPark(
	home: string,
	sessionId: string,
): Promise<ScheduledPark | undefined> {
	const paths = schedulePaths(home)
	for (const job of listJobs(paths).jobs) {
		const run = readState(paths, job.id).activeRun
		if (run?.status !== 'awaiting-approval' || run.sessionId !== sessionId || !run.projectSlug)
			continue
		const log = DiskSessionLog.at(new SessionPaths({ home, slug: run.projectSlug }), {
			sessionId: asSessionId(sessionId),
		})
		const park = await findPendingCheckpoint(log)
		const handoff = park ? undefined : await pausedForHandoff(log, run.turnId)
		if (park && park.pending.request.type !== 'tool_review') return undefined
		const turnId = park?.pending.request.turnId ?? handoff?.turnId
		if (!turnId) return undefined
		const recorded = await recordedTurnModel(log, turnId)
		const model = job.model.model ?? recorded.model
		const effort = job.model.effort ?? recorded.effort
		return {
			job,
			runId: run.runId,
			turnId,
			model: {
				provider: job.model.provider,
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			},
			toolCalls: park?.pending.request.type === 'tool_review' ? park.pending.request.toolCalls : [],
			...(handoff ? { handoff: handoff.handoff } : {}),
		}
	}
	return undefined
}

/**
 * The turn's handoff, when its latest segment ended with `turn_paused`
 * carrying one: a tool asked for a person and nothing has resumed the turn
 * since. `turnId` narrows it to the run's turn when the run recorded one.
 */
async function pausedForHandoff(
	log: Pick<DiskSessionLog, 'read'>,
	turnId: string | undefined,
): Promise<{ turnId: string; handoff: ScheduledHandoff } | undefined> {
	let latest: { turnId: string; handoff: ScheduledHandoff } | undefined
	try {
		for await (const { record } of log.read({ mode: 'strict' })) {
			if (!('turnId' in record) || typeof record.turnId !== 'string') continue
			if (turnId !== undefined && record.turnId !== turnId) continue
			if (record.type === 'turn_paused') {
				latest = record.handoff
					? {
							turnId: record.turnId,
							handoff: {
								reason: record.handoff.reason,
								...(record.handoff.detail ? { detail: record.handoff.detail } : {}),
							},
						}
					: undefined
			} else if (
				record.type === 'turn_resuming' ||
				record.type === 'turn_completed' ||
				record.type === 'turn_failed'
			) {
				latest = undefined
			}
		}
	} catch {
		return undefined
	}
	return latest
}

/** The model and effort a turn's `turn_started` recorded, when it recorded them. */
async function recordedTurnModel(
	log: Pick<DiskSessionLog, 'read'>,
	turnId: string,
): Promise<{ model?: string; effort?: string }> {
	try {
		for await (const { record } of log.read({ mode: 'strict' })) {
			if (record.type !== 'turn_started' || record.turnId !== turnId) continue
			const config: Record<string, unknown> = { ...record.config }
			return {
				...(typeof config.model === 'string' ? { model: config.model } : {}),
				...(typeof config.effort === 'string' ? { effort: config.effort } : {}),
			}
		}
	} catch {
		// An unreadable log leaves the job's own pin; the provider default fills the rest.
	}
	return {}
}

const STRICTER: readonly PermissionMode[] = ['plan', 'strict']

/** What the TUI session a scheduled turn would resume in actually runs with. */
export interface ResumeEnvironment {
	readonly cwd: string
	/** The session's extra roots (`--add-dir`, `/add-dir`). */
	readonly roots: readonly string[]
	/** Whether the session's commands run in a sandbox. */
	readonly sandboxed: boolean
	/**
	 * The providers this session has a credential for, by id; the resumed
	 * turn runs on the job's. Absent: not checked here (the turn still fails
	 * without one, after the question).
	 */
	readonly providers?: readonly string[]
	/**
	 * Whether this session has the browser tools. Absent: not checked. A job
	 * with a browser grant cannot continue in a session without them.
	 */
	readonly browser?: boolean
}

function canonical(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

/**
 * How `environment` differs from what the job's runs get, one phrase each;
 * empty when a resumed turn would run exactly as the job's own run did.
 */
export function scheduledResumeMismatch(
	job: ScheduleJob,
	environment: ResumeEnvironment,
): string[] {
	const reasons: string[] = []
	const wantsSandbox = job.permissions.execution === 'sandbox'
	// Where commands run matters only to a job that can run one: a browser
	// job with bash denied continues the same in either session.
	if (allowsCommands(job.permissions) && environment.sandboxed !== wantsSandbox) {
		reasons.push(
			wantsSandbox
				? 'the job runs commands in a sandbox and this session runs them on the host'
				: 'the job runs commands on the host and this session runs them in a sandbox',
		)
	}
	if (canonical(environment.cwd) !== job.folder.canonical) {
		reasons.push(`this session's folder is not the job's (${job.folder.canonical})`)
	}
	const jobRoots = new Set((job.permissions.additionalDirectories ?? []).map(canonical))
	const sessionRoots = new Set(environment.roots.map(canonical))
	const extra = [...sessionRoots].filter((root) => !jobRoots.has(root))
	const missing = [...jobRoots].filter((root) => !sessionRoots.has(root))
	if (extra.length > 0) reasons.push(`this session also reaches ${extra.join(', ')}`)
	if (missing.length > 0) reasons.push(`this session does not reach ${missing.join(', ')}`)
	if (job.permissions.browser && environment.browser === false) {
		reasons.push(
			'the job drives the browser and this session has none (check `browser.enabled` and `namzu doctor`)',
		)
	}
	if (environment.providers && !environment.providers.includes(job.model.provider)) {
		reasons.push(
			`the job runs on ${job.model.provider}${job.model.model ? `/${job.model.model}` : ''} and this session has no credential for ${job.model.provider} (sign in with \`namzu login\`, or set its API key)`,
		)
	}
	return reasons
}

function describeModel(model: ScheduledPark['model']): string {
	return model.model ? `${model.provider}/${model.model}` : model.provider
}

/**
 * The operator's permission screen for a scheduled turn: one prompt at a
 * time, each for its own batch only.
 *
 * Batch-only because a scheduled run has no session-wide approval, so the
 * screen offers no "allow all" (and an "approve-all" that reached here
 * anyway is answered as "yes" for the batch on screen). One at a time
 * because the screen answers every prompt it has queued with an "allow all"
 * given to another; a scheduled turn's later batches would be approved
 * without ever being shown.
 */
function scheduledPermission(ask: ScreenPermissionFn): PermissionFn {
	let queue: Promise<unknown> = Promise.resolve()
	return (request) => {
		const answer = queue.then(() => ask({ ...request, batchOnly: true }))
		queue = answer.catch(() => undefined)
		return answer.then((decision) =>
			decision.kind === 'approve-all' ? { kind: 'approve' as const } : decision,
		)
	}
}

/** What `resumePaused` needs to continue a parked scheduled turn. */
export type ScheduledResumeParams = Pick<
	ResumePausedParams,
	'pendingDecision' | 'onPermission' | 'rules' | 'permissionMode' | 'model' | 'systemNote'
> & {
	/**
	 * For a job with a browser grant: the profile and sites the session's
	 * browser must run under while the turn continues (`BrowserControl.runAs`),
	 * so the host holds it to the job's sites as the gate does.
	 */
	readonly browser?: {
		readonly profile: string
		readonly sites: Readonly<Record<string, 'deny' | 'read' | 'ask' | 'act'>>
	}
}

/**
 * The operator's answer to a parked scheduled run: continue it with these
 * parameters, abandon its turn (with the reason to record), or leave it
 * waiting.
 */
export type ScheduledResume =
	| ScheduledResumeParams
	| { readonly abandon: string }
	| { readonly leave: true }

const CONTINUE = 'continue'
const ABANDON = 'abandon'

/**
 * A run a tool paused for a person: say what the tool asked for, then put
 * Continue / Abandon on the choice screen. Esc, or no choice screen, leaves
 * the run waiting.
 */
export async function chooseHandoffContinuation(
	park: Pick<ScheduledPark, 'job' | 'runId' | 'model' | 'handoff'>,
	choose: QuestionFn | undefined,
	say: (text: string) => void,
): Promise<'continue' | 'abandon' | 'leave'> {
	const handoff = park.handoff
	if (!handoff) return 'leave'
	// Read back from the log, so shown as data: one line each.
	const safe = (text: string) => terminalDisplayText(text).replace(/\s+/g, ' ').trim()
	// The browser's details in words; anything else a tool sent, as it sent it.
	const facts = handoff.detail ?? {}
	const known = new Set(['tool', 'cause', 'origin', 'profile', 'loginCommand'])
	const where = [
		facts.origin ? `site ${safe(facts.origin)}` : '',
		facts.profile ? `browser profile ${safe(facts.profile)}` : '',
	].filter(Boolean)
	const detail = [
		...(where.length > 0 ? [`\n  ${where.join(' · ')}`] : []),
		...(facts.loginCommand
			? [`\n  If you have not signed in again yet: ${safe(facts.loginCommand)}`]
			: []),
		...Object.entries(facts)
			.filter(([key]) => !known.has(key))
			.map(([key, value]) => `\n  ${safe(key)}: ${safe(value)}`),
	].join('')
	say(
		`⏲ The scheduled job ${park.job.name} stopped because it needs you: ${safe(handoff.reason)}${detail}\nContinue once that is done: the turn goes on under the job’s rules and on its model (${describeModel(park.model)}).`,
	)
	if (!choose) return 'leave'
	const choice = await choose({
		questionId: `schedule-handoff:${park.runId}`,
		header: park.job.name,
		question: 'Continue the scheduled run?',
		options: [
			{ id: CONTINUE, label: 'Continue', description: 'It is done; carry on from here' },
			{ id: ABANDON, label: 'Abandon', description: 'Stop this run; the job stays scheduled' },
		],
		multiSelect: false,
		allowFreeText: false,
	})
	if (choice.kind !== 'answer') return 'leave'
	if (choice.selectedOptionIds.includes(CONTINUE)) return 'continue'
	if (choice.selectedOptionIds.includes(ABANDON)) return 'abandon'
	return 'leave'
}

/**
 * Ask the operator about the parked batch — or, for a handoff park, whether
 * to continue — and return what `resumePaused` needs, or `undefined` when
 * this session is not a parked scheduled run.
 */
export async function prepareScheduledResume(input: {
	readonly home: string
	readonly sessionId: string
	readonly operatorMode: PermissionMode
	readonly environment: ResumeEnvironment
	readonly ask: ScreenPermissionFn
	/** The choice screen, for a handoff park's Continue / Abandon. */
	readonly choose?: QuestionFn
	readonly say: (text: string) => void
}): Promise<ScheduledResume | undefined> {
	const park = await findScheduledPark(input.home, input.sessionId)
	if (!park) return undefined
	const mismatch = scheduledResumeMismatch(park.job, input.environment)
	if (mismatch.length > 0) {
		const execution =
			park.job.permissions.execution === 'sandbox'
				? ' with `sandbox.enabled: true` in your config'
				: ' with the sandbox off (`sandbox.enabled: false`)'
		throw new Error(
			`the scheduled job ${park.job.name} ${park.handoff ? 'is waiting for you' : 'is waiting for approval'}, but its turn must continue as the job runs: ${mismatch.join('; ')}. ${park.handoff ? 'Continue' : 'Answer'} it from a session that matches: ${resumeCommand(park.job, input.sessionId)}${mismatch.some((reason) => reason.includes('sandbox')) ? execution : ''}.`,
		)
	}
	const ask = scheduledPermission(input.ask)
	const layers = readPermissionLayers({ cwd: park.job.folder.canonical })
	const policy = compileJobPolicy(park.job.permissions, { layers, namzuHome: input.home })
	const grant = park.job.permissions.browser
	const resumeWith = (pendingDecision?: HITLResumeDecision): ScheduledResumeParams => ({
		...(pendingDecision ? { pendingDecision } : {}),
		onPermission: ask,
		rules: policy.rules,
		permissionMode: STRICTER.includes(input.operatorMode) ? input.operatorMode : policy.mode,
		model: park.model,
		...(grant
			? {
					browser: {
						profile: grant.profile,
						sites: {
							...grant.sites,
							...Object.fromEntries(
								layers
									.flatMap((layer) => layer.browserDenies ?? [])
									.map((site) => [site, 'deny' as const]),
							),
							'*': 'deny' as const,
						},
					},
				}
			: {}),
	})
	if (park.handoff) {
		const choice = await chooseHandoffContinuation(park, input.choose, input.say)
		if (choice === 'continue') {
			return {
				...resumeWith(),
				systemNote: handoffContinuationNote(
					park.handoff.reason,
					new Date(),
					park.job.schedule.kind === 'cron' ? park.job.schedule.tz : hostTimeZone(),
				),
			}
		}
		if (choice === 'abandon')
			return { abandon: 'Scheduled run: the operator abandoned it at a handoff' }
		return { leave: true }
	}
	input.say(
		`⏲ The scheduled job ${park.job.name} is waiting for your approval. Approve runs exactly this batch; the rest of the turn stays under the job’s rules and on its model (${describeModel(park.model)}), and asks you again, one batch at a time.`,
	)
	const answer = await ask({
		sessionId: input.sessionId as never,
		turnId: park.turnId as never,
		toolCalls: park.toolCalls,
	})
	return resumeWith(
		answer.kind === 'reject'
			? { action: 'reject_tools', feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK }
			: { action: 'approve_tools' },
	)
}
