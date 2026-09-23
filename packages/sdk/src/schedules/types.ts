/**
 * Types of the schedule time engine and evaluator.
 *
 * The SDK owns WHEN something is due and nothing about how a host stores a
 * job or runs it: the CLI keeps its job files, claims and history records to
 * itself, so its on-disk format is not SDK API. The unions exported here
 * (`ScheduleDecision`, `ScheduleSkipReason`, `ScheduleMissedReason`) may grow
 * in a minor release; switch over them with a `default:` branch.
 */

/** A single instant (ISO-8601 UTC). */
export interface ScheduleAtSpec {
	readonly kind: 'at'
	readonly at: string
}

/**
 * Elapsed time from an anchor: `anchorAt + k * everyMs` for k ≥ 1. Pure UTC
 * arithmetic, so `every 24h` drifts against the wall clock across a DST
 * change; a cron spec is the way to say "every day at 09:00".
 */
export interface ScheduleEverySpec {
	readonly kind: 'every'
	/** At least one minute, and a whole number of minutes. */
	readonly everyMs: number
	readonly anchorAt: string
}

/** Five-field cron, evaluated in an IANA time zone the spec carries. */
export interface ScheduleCronSpec {
	readonly kind: 'cron'
	/** Normalised five-field text; macros are expanded. */
	readonly expr: string
	readonly tz: string
}

export type ScheduleSpec = ScheduleAtSpec | ScheduleEverySpec | ScheduleCronSpec

/** A parsed cron expression: each field as the sorted set of values it allows. */
export interface CronExpression {
	readonly source: string
	readonly minutes: readonly number[]
	readonly hours: readonly number[]
	readonly daysOfMonth: readonly number[]
	readonly months: readonly number[]
	/** 0-6, Sunday = 0 (a written 7 is folded into 0). */
	readonly daysOfWeek: readonly number[]
	/** The day-of-month field does not start with `*`. */
	readonly domRestricted: boolean
	/** The day-of-week field does not start with `*`. */
	readonly dowRestricted: boolean
	/**
	 * Minute and hour are single values or lists with no `*` or step. Decides
	 * the DST rule (cronie's): a fixed-time job fires once per day across a
	 * DST change, a wildcard job fires at every instant whose wall time
	 * matches.
	 */
	readonly fixedTime: boolean
}

/** Why an occurrence did not run. May grow in a minor release. */
export type ScheduleSkipReason =
	| 'previous-run-active'
	| 'previous-run-awaiting-approval'
	| 'paused'
	| 'awaiting-confirmation'
	| 'beyond-catch-up-window'
	| 'one-shot-expired'
	| 'quota-hold'

/** Why occurrences were missed. Best effort; may grow in a minor release. */
export type ScheduleMissedReason = 'daemon-not-running' | 'machine-asleep' | 'clock-jumped-forward'

/** The lifecycle a job is in, as far as the evaluator cares. */
export type ScheduleJobLifecycle =
	| 'pending-confirmation'
	| 'active'
	| 'paused'
	| 'completed'
	| 'expired'

/** The evaluator's structural view of a job: what it needs and nothing else. */
export interface ScheduleEvaluationJob {
	readonly spec: ScheduleSpec
	readonly state: ScheduleJobLifecycle
	/** Catch-up window; default {@link SCHEDULE_CATCH_UP_WINDOW_MS}. */
	readonly catchUp?: { readonly windowMs: number }
	readonly createdAt: string
	readonly updatedAt: string
	/** Bumped on every definition change. */
	readonly revision: number
}

/** What the host remembers between evaluations of one job. */
export interface ScheduleEvaluationState {
	/** Everything up to and including this instant has been decided. */
	readonly lastEvaluatedAt?: string
	/** The job revision `lastEvaluatedAt` was computed under. */
	readonly jobRevision?: number
	/** A run of this job that has not finished (or a fire queued but not started). */
	readonly activeRun?: { readonly status: 'queued' | 'running' | 'awaiting-approval' }
	/** Provider asked to be left alone until this instant. */
	readonly quotaHoldUntil?: string
}

export interface ScheduleObservedGap {
	readonly from: Date
	readonly to: Date
	readonly kind: 'asleep' | 'clock-forward' | 'clock-backward'
}

export interface ScheduleEvaluationInput {
	readonly job: ScheduleEvaluationJob
	readonly state: ScheduleEvaluationState
	readonly now: Date
	/** When this daemon instance started, and a gap it observed itself. */
	readonly daemon: { readonly startedAt: Date; readonly observedGap?: ScheduleObservedGap }
	/** How late a fire may be and still count as on time; default {@link SCHEDULE_LATE_GRACE_MS}. */
	readonly lateGraceMs?: number
	/** Whether an occurrence key was already started (claimed) by someone. */
	readonly isClaimed?: (key: string) => boolean
}

export type ScheduleFireTrigger = 'scheduled' | 'late' | 'catch-up'

/** What to do about one job now. May grow in a minor release. */
export interface ScheduleDecision {
	readonly fire?: {
		/** Occurrence key: the scheduled instant in epoch milliseconds. */
		readonly key: string
		readonly scheduledFor: Date
		readonly trigger: ScheduleFireTrigger
	}
	/** Occurrences that will not run, collapsed: one entry per reason. */
	readonly skip: readonly {
		readonly scheduledFor: Date
		readonly reason: ScheduleSkipReason
		readonly count: number
	}[]
	readonly missed?: {
		readonly from: Date
		readonly to: Date
		readonly count: number
		/** The count stopped at the cap; the real number is at least `count`. */
		readonly capped: boolean
		readonly reason: ScheduleMissedReason
	}
	readonly jobTransition?: 'completed' | 'expired'
	readonly nextState: {
		readonly lastEvaluatedAt: Date
		readonly nextFireAt?: Date
		readonly jobRevision: number
	}
}

/** How occurrences in a window were counted. */
export interface OccurrenceCount {
	readonly count: number
	/** The count stopped at the cap. */
	readonly capped: boolean
	readonly first?: Date
	readonly latest?: Date
}
