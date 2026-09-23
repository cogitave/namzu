/**
 * The scheduler's records. These are the CLI's on-disk format and not SDK
 * API: adding a status or a record kind here is a CLI change.
 *
 * Every file carries `v` and `kind`. A reader that finds a `v` it does not
 * know refuses and names the file; it never rewrites it.
 */

import type { ScheduleJobLifecycle, ScheduleSpec } from '@namzu/sdk'
import type { PermissionsConfig } from '../permissions/rules.js'

export const SCHEDULE_FORMAT_VERSION = 1

/** What a scheduled run may do. Required on every job; there is no default. */
export interface SchedulePermissionSet {
	/** A call no rule covers: `park` (wait for the operator), `deny`, or `allow`. */
	readonly unmatched: 'park' | 'deny' | 'allow'
	/** Where the run's commands execute. */
	readonly execution: 'host' | 'sandbox'
	/** The expanded rules, in the `[permissions]` vocabulary, stored verbatim. */
	readonly rules: PermissionsConfig
	/** Extra roots besides the folder, canonical. */
	readonly additionalDirectories?: readonly string[]
	/** Where the rules came from, for display only. */
	readonly preset?: 'read-only' | 'edit-in-folder' | 'custom'
}

export interface ScheduleBudget {
	readonly maxIterations: number
	/** Required above zero: an unattended run always has a token ceiling. */
	readonly tokenBudget: number
	/** Required above zero: an unattended run always has a wall clock. */
	readonly timeoutMs: number
	readonly waitForProviderMs: number
}

/** A digest of the project config that executes code, pinned at confirmation. */
export interface ProjectDigest {
	readonly algo: 'sha256'
	/** Relative path → content digest, or `absent`. */
	readonly files: Readonly<Record<string, string>>
	/** The `namzu.config.json` sections covered. */
	readonly sections: readonly string[]
}

export type ConfirmationSurface = 'cli-tty' | 'tui' | 'tool-confirmed' | 'cli-noninteractive'

export interface ScheduleJob {
	readonly v: 1
	readonly kind: 'schedule-job'
	readonly id: string
	readonly name: string
	readonly revision: number
	readonly createdAt: string
	readonly updatedAt: string
	readonly createdBy: { readonly surface: 'cli' | 'tui' | 'tool'; readonly sessionId?: string }
	readonly prompt: string
	readonly folder: { readonly path: string; readonly canonical: string }
	readonly trust: {
		readonly canonical: string
		readonly grantedAt: string
		readonly by: 'operator-confirmation'
	} | null
	readonly schedule: ScheduleSpec
	readonly permissions: SchedulePermissionSet
	readonly budget: ScheduleBudget
	readonly model: { readonly provider: string; readonly model?: string; readonly effort?: string }
	readonly catchUp: { readonly windowMs: number }
	readonly notify: {
		readonly finished: boolean
		readonly failed: boolean
		readonly awaitingApproval: boolean
		readonly includeSummary: boolean
	}
	readonly failurePolicy: { readonly pauseAfterFailures: number }
	readonly retention: { readonly keepSessions: number }
	readonly state: ScheduleJobLifecycle
	readonly pausedAt?: string
	readonly pausedBy?: 'operator' | 'auto-failure-streak' | 'tool'
	/** How long a run may stay parked on a decision before it is abandoned. */
	readonly approvalTtlMs: number
	readonly projectDigest: ProjectDigest
	/** Null until confirmed on a terminal or in the TUI. */
	readonly confirmation: {
		readonly at: string
		readonly surface: ConfirmationSurface
		/** sha256 of the security fields at confirmation. */
		readonly digest: string
	} | null
}

export type ScheduleRunStatus =
	| 'running'
	| 'completed'
	| 'failed'
	| 'awaiting-approval'
	| 'approval-expired'
	| 'interrupted'
	| 'timed-out'
	| 'blocked-config'
	| 'cancelled'

export type ScheduleRunTrigger = 'scheduled' | 'late' | 'catch-up' | 'manual'

export interface ActiveRun {
	readonly runId: string
	readonly key: string
	readonly trigger: ScheduleRunTrigger
	readonly scheduledFor?: string
	readonly startedAt: string
	readonly daemonEpoch: string
	readonly status: 'running' | 'awaiting-approval'
	readonly sessionId?: string
	/** The session's project directory name under `projects/`. */
	readonly projectSlug?: string
	readonly turnId?: string
	readonly parkedAt?: string
	readonly delayedMs?: number
	readonly delayReason?: 'concurrency-cap' | 'folder-busy'
}

export interface ScheduleJobState {
	readonly v: 1
	readonly kind: 'schedule-state'
	readonly jobId: string
	readonly jobRevision?: number
	readonly lastEvaluatedAt?: string
	readonly nextFireAt?: string
	/** An occurrence decided but not yet started (waiting for a slot or a lane). Claimed at dispatch. */
	readonly queued?: {
		readonly key: string
		readonly scheduledFor: string
		readonly trigger: ScheduleRunTrigger
		readonly queuedAt: string
	}
	readonly activeRun?: ActiveRun
	readonly lastRun?: {
		readonly runId: string
		readonly scheduledFor?: string
		readonly status: ScheduleRunStatus
		readonly endedAt: string
		readonly sessionId?: string
	}
	readonly counters: {
		readonly runs: number
		readonly failures: number
		readonly failureStreak: number
	}
	readonly quotaHoldUntil?: string
	/** The last failure signature notified, so the same failure is told once. */
	readonly lastIncident?: { readonly signature: string; readonly at: string }
	/** The last definition-change notification, by digest, so it is told once. */
	readonly lastHoldNotice?: string
	/** Sessions of this job's runs already archived by retention, newest last. */
	readonly archivedSessions?: readonly string[]
}

export type ScheduleHistoryRecord =
	| {
			readonly v: 1
			readonly kind: 'run'
			readonly at: string
			readonly runId: string
			readonly key: string
			readonly trigger: ScheduleRunTrigger
			readonly scheduledFor?: string
			readonly startedAt: string
			readonly endedAt?: string
			readonly delayedMs?: number
			readonly delayReason?: 'concurrency-cap' | 'folder-busy'
			readonly sessionId?: string
			readonly status: ScheduleRunStatus
			readonly reason?: string
			readonly exitCode?: number
			readonly summary?: string
			readonly usage?: { readonly totalTokens?: number; readonly costUsd?: number }
			readonly warnings?: readonly string[]
	  }
	| {
			readonly v: 1
			readonly kind: 'skip'
			readonly at: string
			readonly scheduledFor: string
			readonly reason: string
			readonly count: number
			readonly detail?: string
	  }
	| {
			readonly v: 1
			readonly kind: 'missed'
			readonly at: string
			readonly from: string
			readonly to: string
			readonly count: number
			readonly capped?: boolean
			readonly reason: string
			readonly caughtUpBy?: string
	  }
	| {
			readonly v: 1
			readonly kind: 'job'
			readonly at: string
			readonly action:
				| 'created'
				| 'edited'
				| 'confirmed'
				| 'paused'
				| 'resumed'
				| 'removed'
				| 'completed'
				| 'expired'
				| 'tampered'
				| 'blocked'
			readonly by: string
			readonly detail?: string
	  }

/** What a fire child leaves behind. Authoritative over its exit code. */
export interface ScheduleRunResult {
	readonly v: 1
	readonly kind: 'schedule-run-result'
	readonly runId: string
	readonly jobId: string
	readonly sessionId?: string
	/** The session's project directory name under `projects/`. */
	readonly projectSlug?: string
	readonly turnId?: string
	readonly status: ScheduleRunStatus
	readonly exitCode: number
	readonly reason?: string
	readonly summary?: string
	readonly usage?: { readonly totalTokens?: number; readonly costUsd?: number }
	/** A provider asked to be left alone this long. */
	readonly retryAfterMs?: number
	/**
	 * Set on `awaiting-approval` when a tool asked for a person rather than a
	 * batch waiting for approval: what the person has to do. Continuing the
	 * run needs no approval, only that.
	 */
	readonly handoff?: { readonly reason: string }
	readonly credentialSource?: string
	readonly warnings?: readonly string[]
	readonly startedAt: string
	readonly endedAt?: string
}
