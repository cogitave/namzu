/**
 * `/resume` of a scheduled run parked on a decision.
 *
 * The parked batch is put to the operator with the ordinary permission
 * screen. Their answer is applied to exactly that batch (`pendingDecision`,
 * the model is not asked again); calls later in the turn are asked of them
 * live; and the resumed turn is gated by the JOB's rules, recompiled now
 * from the job, not by the folder config the TUI session was built with. The
 * operator's own mode can only make it stricter.
 *
 * What the rules cannot carry, the TUI session must already match: the
 * resumed turn runs in THIS session's sandbox (or none), working directory
 * and extra roots, so a session whose execution or roots differ from the
 * job's is refused with the command that opens a matching one. And an "allow
 * all" answered here approves only the batch on screen: a scheduled run has
 * no session-wide approval.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
	DiskSessionLog,
	type HITLResumeDecision,
	SessionPaths,
	asSessionId,
	findPendingCheckpoint,
} from '@namzu/sdk'
import { readPermissionLayers } from '../../config/load.js'
import type { PermissionMode } from '../../permissions/mode.js'
import { schedulePaths } from '../../schedule/paths.js'
import { compileJobPolicy } from '../../schedule/policy.js'
import { listJobs } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'
import type { ScheduleJob } from '../../schedule/types.js'
import type { PermissionFn, ResumePausedParams } from '../agent.js'

export interface ScheduledPark {
	readonly job: ScheduleJob
	readonly runId: string
	readonly turnId: string
	readonly toolCalls: Extract<
		NonNullable<Awaited<ReturnType<typeof findPendingCheckpoint>>>['pending']['request'],
		{ type: 'tool_review' }
	>['toolCalls']
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
		if (!park || park.pending.request.type !== 'tool_review') return undefined
		return {
			job,
			runId: run.runId,
			turnId: park.pending.request.turnId,
			toolCalls: park.pending.request.toolCalls,
		}
	}
	return undefined
}

const STRICTER: readonly PermissionMode[] = ['plan', 'strict']

/** What the TUI session a scheduled turn would resume in actually runs with. */
export interface ResumeEnvironment {
	readonly cwd: string
	/** The session's extra roots (`--add-dir`, `/add-dir`). */
	readonly roots: readonly string[]
	/** Whether the session's commands run in a sandbox. */
	readonly sandboxed: boolean
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
	if (environment.sandboxed !== wantsSandbox) {
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
	return reasons
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9._/@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command that opens a TUI session matching the job, for the refusal. */
function matchingResumeCommand(job: ScheduleJob, sessionId: string): string {
	const addDirs = (job.permissions.additionalDirectories ?? [])
		.map((dir) => ` --add-dir ${shellQuote(dir)}`)
		.join('')
	return `cd ${shellQuote(job.folder.canonical)} && namzu${addDirs} resume ${sessionId}`
}

/**
 * The operator's permission screen for a scheduled turn: one prompt at a
 * time, and "allow all" answered as "yes" for the batch on screen.
 *
 * One at a time because the screen answers every prompt it has queued with
 * an "allow all" given to another; a scheduled turn's later batches would be
 * approved without ever being shown.
 */
function scheduledPermission(ask: PermissionFn): PermissionFn {
	let queue: Promise<unknown> = Promise.resolve()
	return (request) => {
		const answer = queue.then(() => ask(request))
		queue = answer.catch(() => undefined)
		return answer.then((decision) =>
			decision.kind === 'approve-all' ? { kind: 'approve' as const } : decision,
		)
	}
}

/**
 * Ask the operator about the parked batch and return what `resumePaused`
 * needs, or `undefined` when this session is not a parked scheduled run.
 */
export async function prepareScheduledResume(input: {
	readonly home: string
	readonly sessionId: string
	readonly operatorMode: PermissionMode
	readonly environment: ResumeEnvironment
	readonly ask: PermissionFn
	readonly say: (text: string) => void
}): Promise<
	| Pick<ResumePausedParams, 'pendingDecision' | 'onPermission' | 'rules' | 'permissionMode'>
	| undefined
> {
	const park = await findScheduledPark(input.home, input.sessionId)
	if (!park) return undefined
	const mismatch = scheduledResumeMismatch(park.job, input.environment)
	if (mismatch.length > 0) {
		const execution =
			park.job.permissions.execution === 'sandbox'
				? ' with `sandbox.enabled: true` in your config'
				: ' with the sandbox off (`sandbox.enabled: false`)'
		throw new Error(
			`the scheduled job ${park.job.name} is waiting for approval, but its turn must continue as the job runs: ${mismatch.join('; ')}. Answer it from a session that matches: ${matchingResumeCommand(park.job, input.sessionId)}${execution}.`,
		)
	}
	const ask = scheduledPermission(input.ask)
	const policy = compileJobPolicy(park.job.permissions, {
		layers: readPermissionLayers({ cwd: park.job.folder.canonical }),
		namzuHome: input.home,
	})
	input.say(
		`⏲ The scheduled job ${park.job.name} is waiting for your approval. Approve runs exactly this batch; the rest of the turn stays under the job’s rules and asks you again, one batch at a time.`,
	)
	const answer = await ask({
		sessionId: input.sessionId as never,
		turnId: park.turnId as never,
		toolCalls: park.toolCalls,
	})
	const pendingDecision: HITLResumeDecision =
		answer.kind === 'reject'
			? { action: 'reject_tools', feedback: answer.feedback ?? 'The operator declined this call.' }
			: { action: 'approve_tools' }
	return {
		pendingDecision,
		onPermission: ask,
		rules: policy.rules,
		permissionMode: STRICTER.includes(input.operatorMode) ? input.operatorMode : policy.mode,
	}
}
