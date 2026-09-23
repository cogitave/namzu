/**
 * What to do about one job now: fire, skip, record a miss, or nothing.
 *
 * Pure: no clock, no I/O. The host passes the instant, the state it kept and
 * whether an occurrence was already claimed, and applies the decision itself
 * (append history, claim, dispatch). Evaluating the same `(state, now)` twice
 * gives the same answer, so a host that lost its in-memory queue rebuilds it
 * by evaluating again; an already-claimed key is never fired twice.
 *
 * Rules, in order:
 *
 * 1. Occurrences due are those in `(lastEvaluatedAt, now]`, counted with a
 *    cap and never enumerated. A new job counts from its creation. A changed
 *    revision counts from the change, so editing `0 3 * * *` into `0 4 * * *`
 *    does not invent catch-ups for 04:00s that never belonged to the job.
 * 2. `lastEvaluatedAt` never moves backwards: after a backward clock jump
 *    nothing is due until the wall clock passes it again.
 * 3. A job that is not active produces skip records only (paused and
 *    awaiting-confirmation are collapsed per evaluation). A one-shot whose
 *    time passed while inactive is expired.
 * 4. The latest due occurrence fires on time (`scheduled`, or `late` once
 *    more than five seconds late) within the late grace; within the catch-up
 *    window it fires once as `catch-up` and everything earlier is one
 *    `missed` record; older than the window, nothing fires.
 * 5. An unfinished run of the same job skips what came due meanwhile.
 * 6. A provider quota hold skips what comes due before the hold ends.
 */

import { countOccurrences, nextFireTime, previousFireTime } from './next-fire.js'
import type {
	ScheduleDecision,
	ScheduleEvaluationInput,
	ScheduleMissedReason,
	ScheduleSkipReason,
} from './types.js'

/** Default catch-up window: seven days. */
export const SCHEDULE_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Default grace for a fire to still count as on time: two minutes. */
export const SCHEDULE_LATE_GRACE_MS = 120_000
/** A fire later than this is reported `late` rather than `scheduled`. */
const LATE_THRESHOLD_MS = 5_000

type Skip = ScheduleDecision['skip'][number]

function missedReason(input: ScheduleEvaluationInput, firstMissed: Date): ScheduleMissedReason {
	const gap = input.daemon.observedGap
	if (gap && firstMissed.getTime() >= gap.from.getTime()) {
		if (gap.kind === 'asleep') return 'machine-asleep'
		if (gap.kind === 'clock-forward') return 'clock-jumped-forward'
	}
	return 'daemon-not-running'
}

/** Evaluate one job at `now`. */
export function evaluateJob(input: ScheduleEvaluationInput): ScheduleDecision {
	const { job, state, now } = input
	const nowMs = now.getTime()
	const lateGrace = input.lateGraceMs ?? SCHEDULE_LATE_GRACE_MS
	const windowMs = job.catchUp?.windowMs ?? SCHEDULE_CATCH_UP_WINDOW_MS

	let baseMs = Date.parse(state.lastEvaluatedAt ?? job.createdAt)
	if (!Number.isFinite(baseMs)) baseMs = Date.parse(job.createdAt)
	if (state.jobRevision !== undefined && state.jobRevision !== job.revision) {
		baseMs = Math.max(baseMs, Date.parse(job.updatedAt))
	}
	const nextState = (evaluatedMs: number): ScheduleDecision['nextState'] => {
		const next = nextFireTime(job.spec, new Date(evaluatedMs))
		return {
			lastEvaluatedAt: new Date(evaluatedMs),
			...(next ? { nextFireAt: next } : {}),
			jobRevision: job.revision,
		}
	}

	if (job.state === 'completed' || job.state === 'expired') {
		return {
			skip: [],
			nextState: { lastEvaluatedAt: new Date(Math.max(baseMs, nowMs)), jobRevision: job.revision },
		}
	}
	// Rule 2: a clock that went backwards decides nothing new.
	if (nowMs <= baseMs) return { skip: [], nextState: nextState(baseMs) }

	const due = countOccurrences(job.spec, new Date(baseMs), now)
	if (due.count === 0 || !due.latest) {
		if (job.spec.kind === 'at' && Date.parse(job.spec.at) <= baseMs && job.state !== 'active') {
			return { skip: [], jobTransition: 'expired', nextState: nextState(nowMs) }
		}
		return { skip: [], nextState: nextState(nowMs) }
	}
	const latest = due.latest

	const collapsed = (reason: ScheduleSkipReason): Skip[] => [
		{ scheduledFor: latest, reason, count: due.count },
	]

	if (job.state === 'paused' || job.state === 'pending-confirmation') {
		const reason: ScheduleSkipReason = job.state === 'paused' ? 'paused' : 'awaiting-confirmation'
		return {
			skip: collapsed(reason),
			...(job.spec.kind === 'at' ? { jobTransition: 'expired' as const } : {}),
			nextState: nextState(nowMs),
		}
	}

	const hold = state.quotaHoldUntil ? Date.parse(state.quotaHoldUntil) : Number.NaN
	if (Number.isFinite(hold) && hold > nowMs) {
		return { skip: collapsed('quota-hold'), nextState: nextState(nowMs) }
	}

	if (state.activeRun) {
		return {
			skip: collapsed(
				state.activeRun.status === 'awaiting-approval'
					? 'previous-run-awaiting-approval'
					: 'previous-run-active',
			),
			nextState: nextState(nowMs),
		}
	}

	const key = String(latest.getTime())
	const lateBy = nowMs - latest.getTime()
	const earlier = due.count - 1
	const missedBefore = (): ScheduleDecision['missed'] | undefined => {
		if (earlier <= 0 || !due.first) return undefined
		// The occurrence just before the fired one.
		const to = previousFireTime(job.spec, new Date(latest.getTime() - 1)) ?? due.first
		return {
			from: due.first,
			to,
			count: earlier,
			capped: due.capped,
			reason: missedReason(input, due.first),
		}
	}
	const transition = job.spec.kind === 'at' ? { jobTransition: 'completed' as const } : {}

	if (input.isClaimed?.(key)) {
		// Somebody already started it; nothing to fire, nothing missed.
		return { skip: [], ...transition, nextState: nextState(nowMs) }
	}

	if (lateBy <= lateGrace || lateBy <= windowMs) {
		const trigger =
			lateBy <= lateGrace ? (lateBy > LATE_THRESHOLD_MS ? 'late' : 'scheduled') : 'catch-up'
		const missed = missedBefore()
		return {
			fire: { key, scheduledFor: latest, trigger },
			skip: [],
			...(missed ? { missed } : {}),
			...transition,
			nextState: nextState(nowMs),
		}
	}

	// Everything due is older than the window.
	const first = due.first ?? latest
	return {
		skip: [
			{
				scheduledFor: latest,
				reason: job.spec.kind === 'at' ? 'one-shot-expired' : 'beyond-catch-up-window',
				count: 1,
			},
		],
		missed: {
			from: first,
			to: latest,
			count: due.count,
			capped: due.capped,
			reason: missedReason(input, first),
		},
		...(job.spec.kind === 'at' ? { jobTransition: 'expired' as const } : {}),
		nextState: nextState(nowMs),
	}
}
