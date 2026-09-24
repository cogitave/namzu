/**
 * The scheduler's records. These are the CLI's on-disk format and not SDK
 * API: adding a status or a record kind here is a CLI change.
 *
 * Every file carries `v` and `kind`. A reader that finds a `v` it does not
 * know refuses and names the file; it never rewrites it.
 */

import type { ScheduleBrowserGrant, ScheduleJobLifecycle, ScheduleSpec } from '@namzu/sdk'
import type { PermissionsConfig } from '../permissions/rules.js'

/** The format before `runKind`/`script`/`check-failed` existed. Always readable. */
export const SCHEDULE_FORMAT_VERSION_LEGACY = 1
/**
 * The current format. A job/run-result/history record is written at this
 * version only when it actually carries what a `SCHEDULE_FORMAT_VERSION_LEGACY`
 * reader cannot interpret (`runKind !== 'agent'`, a `script` block, a
 * `check-failed` status, `gateResult` or `scriptOutput`); everything else is
 * still written at the legacy version, unchanged, so an old namzu keeps
 * reading every job and record it always could.
 */
export const SCHEDULE_FORMAT_VERSION = 2

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
	/**
	 * Browser access. Absent: the `browser` and `browser_act` tools are
	 * denied. Present: the run drives the browser under `profile` (signed in
	 * beforehand with `namzu browser login`), reaches only the listed sites
	 * (canonical keys, never `*`) at their level, and every other site is
	 * denied. `ask` needs `unmatched: park`: each such call waits for the
	 * operator. No window unless `headed`.
	 */
	readonly browser?: ScheduleBrowserGrant
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

/** What a run does. Absent (a `v:1` file): `'agent'`. */
export type ScheduleRunKind = 'agent' | 'script' | 'script+agent'

export interface ScheduleJob {
	readonly v: 1 | 2
	readonly kind: 'schedule-job'
	readonly id: string
	readonly name: string
	readonly revision: number
	readonly createdAt: string
	readonly updatedAt: string
	readonly createdBy: { readonly surface: 'cli' | 'tui' | 'tool'; readonly sessionId?: string }
	/** The operator's instruction to the model. Empty for a pure `script` job. */
	readonly prompt: string
	/** What this job does. Absent on a `v:1` file, which is read as `'agent'`. */
	readonly runKind?: ScheduleRunKind
	/** Present for `runKind: 'script'` and as the wake-gate for `'script+agent'`. */
	readonly script?: {
		/** The confirmed script text, verbatim. */
		readonly body: string
		/** No default: chosen when the script was proposed. */
		readonly shell: 'bash' | 'sh'
		/** Separate from `budget.timeoutMs`. */
		readonly timeoutMs: number
	}
	/** Present only for `runKind: 'script+agent'`. */
	readonly wakeGate?: {
		/** Cap on the gate's `context` string, cut with an explicit marker. */
		readonly maxContextChars: number
	}
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
	/**
	 * `runKind: 'script'` or `'script+agent'` only: the script (or the
	 * wake-gate) itself malfunctioned — non-zero exit, its own timeout, or
	 * stdout that is not the wake-gate's contract. Independent of whether an
	 * agent phase would have succeeded.
	 */
	| 'check-failed'

/** `v:2` only when the job actually uses what a `v:1` reader cannot interpret. */
export function jobFormatVersion(job: Pick<ScheduleJob, 'runKind'>): 1 | 2 {
	return job.runKind !== undefined && job.runKind !== 'agent'
		? SCHEDULE_FORMAT_VERSION
		: SCHEDULE_FORMAT_VERSION_LEGACY
}

/** `v:2` only when the record carries what a `v:1` reader cannot interpret. */
export function runResultVersion(fields: {
	readonly status: ScheduleRunStatus
	readonly gateResult?: unknown
	readonly scriptOutput?: unknown
}): 1 | 2 {
	return fields.status === 'check-failed' ||
		fields.gateResult !== undefined ||
		fields.scriptOutput !== undefined
		? SCHEDULE_FORMAT_VERSION
		: SCHEDULE_FORMAT_VERSION_LEGACY
}

export type ScheduleRunTrigger = 'scheduled' | 'late' | 'catch-up' | 'manual'

/**
 * Tool calls of one run that were refused (never ran) or failed (ran and
 * returned an error): how many, and the first one's tool and reason, in one
 * line. Written by the CLI, but a refusal's reason may quote the command the
 * model wrote.
 */
export interface ScheduleCallTally {
	readonly count: number
	readonly first: { readonly tool: string; readonly reason: string }
}

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
	/**
	 * Set when the run is parked because a tool asked for a person (a
	 * sign-in, a CAPTCHA) rather than on a batch waiting for approval: what
	 * the person has to do.
	 */
	readonly handoff?: { readonly reason: string }
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
		/** How many of its calls were refused, when any were. */
		readonly refusedCalls?: number
		/** How many of its calls failed, when any did. */
		readonly failedCalls?: number
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
			readonly v: 1 | 2
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
			readonly refusedCalls?: ScheduleCallTally
			readonly failedCalls?: ScheduleCallTally
			/** `runKind: 'script+agent'` only: what its wake-gate decided. */
			readonly gateResult?: { readonly wake: boolean; readonly contextChars: number }
			/** `runKind: 'script'` or `'script+agent'` only: the script's captured output, capped. */
			readonly scriptOutput?: { readonly stdout: string; readonly stderr: string }
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
			/** For `edited`: the preview lines that differ, `+ added` and `- removed`. */
			readonly changes?: readonly string[]
	  }

/** What a fire child leaves behind. Authoritative over its exit code. */
export interface ScheduleRunResult {
	readonly v: 1 | 2
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
	/**
	 * Calls the run's permissions refused. The status says how the turn
	 * ended; a `completed` run with refused calls did not do all it was
	 * asked, and says so wherever the run is shown.
	 */
	readonly refusedCalls?: ScheduleCallTally
	/** Calls that ran and returned an error. */
	readonly failedCalls?: ScheduleCallTally
	/** `runKind: 'script+agent'` only: what its wake-gate decided. */
	readonly gateResult?: { readonly wake: boolean; readonly contextChars: number }
	/** `runKind: 'script'` or `'script+agent'` only: the script's captured output, capped. */
	readonly scriptOutput?: { readonly stdout: string; readonly stderr: string }
	readonly startedAt: string
	readonly endedAt?: string
}
