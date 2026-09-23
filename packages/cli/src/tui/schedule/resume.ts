/**
 * `/resume` of a scheduled run parked on a decision.
 *
 * The parked batch is put to the operator with the ordinary permission
 * screen. Their answer is applied to exactly that batch (`pendingDecision`,
 * the model is not asked again); calls later in the turn are asked of them
 * live; and the resumed turn is gated by the JOB's rules, recompiled now
 * from the job, not by the folder config the TUI session was built with. The
 * operator's own mode can only make it stricter.
 */

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

/**
 * Ask the operator about the parked batch and return what `resumePaused`
 * needs, or `undefined` when this session is not a parked scheduled run.
 */
export async function prepareScheduledResume(input: {
	readonly home: string
	readonly sessionId: string
	readonly operatorMode: PermissionMode
	readonly ask: PermissionFn
	readonly say: (text: string) => void
}): Promise<
	| Pick<ResumePausedParams, 'pendingDecision' | 'onPermission' | 'rules' | 'permissionMode'>
	| undefined
> {
	const park = await findScheduledPark(input.home, input.sessionId)
	if (!park) return undefined
	const policy = compileJobPolicy(park.job.permissions, {
		layers: readPermissionLayers({ cwd: park.job.folder.canonical }),
		namzuHome: input.home,
	})
	input.say(
		`⏲ The scheduled job ${park.job.name} is waiting for your approval. Approve runs exactly this batch; the rest of the turn stays under the job’s rules and asks you again.`,
	)
	const answer = await input.ask({
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
		onPermission: input.ask,
		rules: policy.rules,
		permissionMode: STRICTER.includes(input.operatorMode) ? input.operatorMode : policy.mode,
	}
}
