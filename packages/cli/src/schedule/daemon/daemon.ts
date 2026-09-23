/**
 * The scheduler daemon: one per `NAMZU_HOME`, started by a user service.
 *
 * ## One owner
 *
 * Ownership is a fenced lease in `schedule/daemon/` — the session lease's own
 * store, `lease.<fence>.json` published with `link`, the highest fence owning,
 * renewed every 30 s with a 90 s expiry. A second daemon does not exit (a
 * supervisor would restart it in a loop): it waits on standby and takes a new
 * fence when the owner's expires. Before every claim the owner checks its
 * fence is still the highest, and one that was fenced out stops dispatching at
 * once. The occurrence claim (`claims/`, also `link`) is the final guarantee
 * that nothing starts twice, lease or no lease.
 *
 * ## The loop
 *
 * Every tick (at most 30 s, sooner when something is due, a job file changes
 * or a run ends): evaluate each job with the SDK's pure evaluator, append what
 * it decided to history, queue what is due, and dispatch the queue up to the
 * concurrency cap — one run at a time per folder for jobs that can write.
 * An occurrence is claimed when its run STARTS, never when it is queued, so a
 * restart re-derives a waiting run instead of losing it.
 *
 * ## Runs
 *
 * A run is a child process, `schedule __fire`, whose stdout and stderr are a
 * log FILE rather than pipes, so it outlives a daemon restart without dying of
 * EPIPE. It enforces its own wall clock. A run this daemon did not start (it
 * was started before a restart) is adopted: finalised from its result file,
 * or from its session log once its lease lapses. Nothing is ever killed by a
 * pid read from disk.
 *
 * ## Upgrades
 *
 * Every tick compares the installed CLI with the one this daemon started
 * from. On a change it stops dispatching, waits for the runs it started and
 * exits 0; the supervisor starts the new code.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import {
	type FSWatcher,
	closeSync,
	existsSync,
	openSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
	DiskSessionLeaseStore,
	type Logger,
	type ScheduleEvaluationState,
	type SessionLease,
	evaluateJob,
	generateScheduleRunId,
} from '@namzu/sdk'
import { admitNotification } from '../../integrations/notifications/desktop/throttle.js'
import { childEnvironment } from '../env.js'
import { isFinal, readRunResult } from '../fire/result.js'
import type { SchedulePaths } from '../paths.js'
import { allowsWrites } from '../policy.js'
import { PRIVATE_FILE_MODE, ensureDir, writeJsonAtomic } from '../store/atomic.js'
import { claimOccurrence, isClaimed, pruneClaims } from '../store/claims.js'
import { appendHistory, compactHistory } from '../store/history.js'
import {
	confirmationHolds,
	jobSecurityDigest,
	listJobs,
	readJob,
	updateJob,
} from '../store/jobs.js'
import { readState, withoutUndefined, writeState } from '../store/state.js'
import type {
	ActiveRun,
	ScheduleJob,
	ScheduleJobState,
	ScheduleRunResult,
	ScheduleRunStatus,
	ScheduleRunTrigger,
} from '../types.js'
import { type EndpointServer, startEndpoint } from './endpoint.js'
import { EXIT_STOP_REQUESTED } from './exit.js'
import { pruneDaemonLogs } from './log.js'
import { type NoticeKind, failureSignature, noticeText } from './notify.js'
import { archiveOldRuns } from './retention.js'
import { abandonParkedTurn, sessionFacts, sessionLeaseLive, turnOutcome } from './sessions.js'

export { EXIT_STOP_REQUESTED }

export const LEASE_TTL_MS = 90_000
export const LEASE_RENEW_MS = 30_000
export const TICK_MS = 30_000
/** A run with no result and no session this long after it started is gone. */
const START_GRACE_MS = 120_000
const CLAIM_RETENTION_EXTRA_MS = 24 * 60 * 60 * 1000
const HOUSEKEEPING_MS = 24 * 60 * 60 * 1000
const GAP_MS = 60_000

export interface SpawnedRun {
	/** Resolves with the exit code (or null when a signal ended it). */
	readonly exited: Promise<number | null>
	/** Only for a child this daemon started and still holds. */
	terminate(): void
}

export interface FireSpawnRequest {
	readonly job: ScheduleJob
	readonly runId: string
	readonly key: string
	readonly trigger: ScheduleRunTrigger
	readonly scheduledFor?: string
	readonly epoch: string
}

export interface DaemonNotice {
	readonly jobId: string
	readonly title: string
	readonly body: string
}

export interface DaemonOptions {
	readonly paths: SchedulePaths
	readonly log: Logger
	readonly version: string
	readonly epoch: string
	readonly maxConcurrentRuns: number
	readonly notifications: boolean
	/** Start a fire child. */
	readonly spawnFire: (request: FireSpawnRequest) => SpawnedRun
	/** Show a desktop notification. Never throws. */
	readonly notify: (notice: DaemonNotice) => Promise<void>
	/** The installed CLI, cheaply: a change means an upgrade happened. */
	readonly fingerprint: () => string
	readonly now?: () => number
	readonly monotonic?: () => number
	readonly tickMs?: number
	readonly leaseTtlMs?: number
	readonly standbyPollMs?: number
	/** Exit 75 instead of waiting on standby (tests, and `--once-or-exit`). */
	readonly onceOrExit?: boolean
	/** Status the endpoint reports about notifications. */
	readonly notificationBackend?: string
	/** Watch `jobs/` for changes; off in tests that drive ticks by hand. */
	readonly watchJobs?: boolean
}

interface Tracked {
	readonly jobId: string
	readonly runId: string
	readonly folder: string
	readonly writes: boolean
	readonly run?: SpawnedRun
}

export class ScheduleDaemon {
	readonly #o: DaemonOptions
	readonly #now: () => number
	readonly #mono: () => number
	readonly #leaseStore: DiskSessionLeaseStore
	#lease: SessionLease | null = null
	#leaseRenewedAt = 0
	#endpoint: EndpointServer | undefined
	#watcher: FSWatcher | undefined
	/** Runs in progress: ours (with a handle) and adopted ones (without). */
	readonly #running = new Map<string, Tracked>()
	#stopping = false
	/** The stop came from `schedule stop`'s file, not a signal or the endpoint. */
	#stopRequestedByFile = false
	#draining = false
	#standby = false
	#wake: (() => void) | undefined
	#lastWall = 0
	#lastMono = 0
	#startedAt = 0
	#observedGap:
		| { from: Date; to: Date; kind: 'asleep' | 'clock-forward' | 'clock-backward' }
		| undefined
	#startFingerprint = ''
	#lastHousekeeping = 0
	#manual: { jobId: string; runId: string }[] = []
	/** Why a queued run is waiting, for its run record once it starts. */
	readonly #delayReasons = new Map<string, 'concurrency-cap' | 'folder-busy'>()
	#finalizing: Promise<void>[] = []

	constructor(options: DaemonOptions) {
		this.#o = options
		this.#now = options.now ?? Date.now
		this.#mono = options.monotonic ?? (() => performance.now())
		this.#leaseStore = new DiskSessionLeaseStore(options.paths.daemon)
	}

	get standby(): boolean {
		return this.#standby
	}

	get lease(): SessionLease | null {
		return this.#lease
	}

	/** Ask the loop to stop at its next wake. Running children are left running. */
	stop(): void {
		this.#stopping = true
		this.#wake?.()
	}

	/** Stop dispatching, wait for our own runs, then stop (an upgrade restart). */
	drainAndRestart(): void {
		this.#draining = true
		this.#persistManual()
		this.#wake?.()
	}

	wake(): void {
		this.#wake?.()
	}

	/** Try once to own the home (for a caller driving {@link tick} itself). */
	async claimOwnership(): Promise<boolean> {
		this.#startFingerprint ||= this.#o.fingerprint()
		this.#startedAt ||= this.#now()
		const lease = await this.#leaseStore.claim({
			holder: this.#o.epoch,
			ttlMs: this.#o.leaseTtlMs ?? LEASE_TTL_MS,
			now: this.#now(),
		})
		if (lease) {
			this.#lease = lease
			this.#leaseRenewedAt = this.#now()
		}
		return lease !== null
	}

	/** Give the home up (a caller driving {@link tick} itself). */
	async releaseOwnership(): Promise<void> {
		if (this.#lease) await this.#leaseStore.release(this.#lease)
		this.#lease = null
	}

	/** Run until stopped. Returns the process exit code. */
	async run(): Promise<number> {
		ensureDir(this.#o.paths.daemon)
		this.#startedAt = this.#now()
		this.#startFingerprint = this.#o.fingerprint()
		for (;;) {
			const acquired = await this.#acquire()
			if (acquired === 'exit75') return 75
			if (acquired === 'stopped') return this.#stopRequestedByFile ? EXIT_STOP_REQUESTED : 0
			const outcome = await this.#own()
			if (outcome === 'standby') continue
			return this.#stopRequestedByFile ? EXIT_STOP_REQUESTED : 0
		}
	}

	async #acquire(): Promise<'owned' | 'exit75' | 'stopped'> {
		let announced = false
		for (;;) {
			if (this.#stopRequested()) this.#stopping = true
			if (this.#stopping) return 'stopped'
			const lease = await this.#leaseStore.claim({
				holder: this.#o.epoch,
				ttlMs: this.#o.leaseTtlMs ?? LEASE_TTL_MS,
				now: this.#now(),
			})
			if (lease) {
				this.#lease = lease
				this.#leaseRenewedAt = this.#now()
				this.#standby = false
				this.#o.log.info('scheduler owns this home', {
					'namzu.schedule.epoch': this.#o.epoch,
					'namzu.schedule.fence': lease.fence,
				})
				return 'owned'
			}
			if (this.#o.onceOrExit) {
				this.#o.log.warn('another scheduler owns this home', {
					'namzu.schedule.epoch': this.#o.epoch,
				})
				return 'exit75'
			}
			this.#standby = true
			if (!announced) {
				announced = true
				this.#o.log.info('scheduler on standby', { 'namzu.schedule.epoch': this.#o.epoch })
			}
			await this.#sleep(this.#o.standbyPollMs ?? LEASE_RENEW_MS)
		}
	}

	async #own(): Promise<'standby' | 'stopped'> {
		this.#endpoint = await startEndpoint(this.#o.paths.endpoint, this.#o.epoch, {
			status: () => this.status(),
			reload: () => this.wake(),
			runNow: (jobId) => this.requestRunNow(jobId),
			stop: () => this.stop(),
			drainAndRestart: () => this.drainAndRestart(),
		})
		if (this.#o.watchJobs !== false) {
			try {
				ensureDir(this.#o.paths.jobs)
				this.#watcher = watch(this.#o.paths.jobs, () => this.wake())
				this.#watcher.on('error', () => {})
			} catch {}
		}
		this.#lastWall = this.#now()
		this.#lastMono = this.#mono()
		try {
			for (;;) {
				if (this.#stopRequested()) this.#stopping = true
				if (this.#stopping) return 'stopped'
				if (!(await this.#holdLease())) {
					this.#o.log.warn('scheduler lost its lease; standing by', {
						'namzu.schedule.epoch': this.#o.epoch,
					})
					return 'standby'
				}
				await this.tick()
				if (this.#draining && this.#ownRuns() === 0) {
					this.#o.log.info('scheduler drained for a restart', {
						'namzu.schedule.epoch': this.#o.epoch,
					})
					this.#stopping = true
					return 'stopped'
				}
				await this.#sleep(this.#nextSleep())
			}
		} finally {
			this.#watcher?.close()
			await this.#endpoint?.close()
			this.#endpoint = undefined
			await Promise.allSettled(this.#finalizing)
			if (this.#stopping) this.#persistManual()
			if (this.#lease && this.#stopping) {
				await this.#leaseStore.release(this.#lease).catch(() => undefined)
				this.#lease = null
			}
			this.#heartbeat()
		}
	}

	/**
	 * `schedule stop` and `uninstall` leave `daemon/stop.json`; `start` and
	 * `install` remove it. It reaches a daemon the service manager cannot: one
	 * on standby (it has no endpoint), or one under WSL, whose Windows task
	 * ending does not end the Linux process. A daemon that finds it exits
	 * {@link EXIT_STOP_REQUESTED}.
	 */
	#stopRequested(): boolean {
		if (!existsSync(stopRequestPath(this.#o.paths))) return false
		this.#stopRequestedByFile = true
		this.#o.log.info('scheduler stop requested', { 'namzu.schedule.epoch': this.#o.epoch })
		return true
	}

	#ownRuns(): number {
		let n = 0
		for (const t of this.#running.values()) if (t.run) n++
		return n
	}

	/** Renew when due; true while this daemon's fence is still the highest. */
	async #holdLease(): Promise<boolean> {
		const lease = this.#lease
		if (!lease) return false
		if (this.#now() - this.#leaseRenewedAt >= LEASE_RENEW_MS) {
			const renewed = await this.#leaseStore.claim(
				{ holder: this.#o.epoch, ttlMs: this.#o.leaseTtlMs ?? LEASE_TTL_MS, now: this.#now() },
				{ renew: lease },
			)
			if (!renewed) {
				this.#lease = null
				return false
			}
			this.#lease = renewed
			this.#leaseRenewedAt = this.#now()
		}
		return this.#stillOwner()
	}

	async #stillOwner(): Promise<boolean> {
		const lease = this.#lease
		return lease !== null && (await this.#leaseStore.fence()) === lease.fence
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(
				() => {
					this.#wake = undefined
					resolve()
				},
				Math.max(10, ms),
			)
			this.#wake = () => {
				clearTimeout(timer)
				this.#wake = undefined
				resolve()
			}
		})
	}

	#nextSleep(): number {
		const tick = this.#o.tickMs ?? TICK_MS
		let soonest = this.#now() + tick
		for (const job of listJobs(this.#o.paths).jobs) {
			try {
				const next = readState(this.#o.paths, job.id).nextFireAt
				if (next) soonest = Math.min(soonest, Date.parse(next) + 50)
			} catch {}
		}
		return Math.max(50, Math.min(tick, soonest - this.#now()))
	}

	/** What the endpoint's `status` reports. */
	status(): Record<string, unknown> {
		return {
			epoch: this.#o.epoch,
			pid: process.pid,
			version: this.#o.version,
			fence: this.#lease?.fence,
			standby: this.#standby,
			draining: this.#draining,
			runs: [...this.#running.values()].map((t) => ({
				jobId: t.jobId,
				runId: t.runId,
				adopted: t.run === undefined,
			})),
			notifications: this.#o.notificationBackend ?? 'unknown',
		}
	}

	/** Queue a manual run (`schedule run-now`). Refused while the job has a run. */
	requestRunNow(jobId: string): { ok: boolean; message: string } {
		const job = readJob(this.#o.paths, jobId)
		if (!job) return { ok: false, message: `no job ${jobId}` }
		if (job.state !== 'active' || !confirmationHolds(job)) {
			return {
				ok: false,
				message: `${job.name} is ${job.state === 'active' ? 'awaiting confirmation' : job.state}`,
			}
		}
		const state = readState(this.#o.paths, job.id)
		if (state.activeRun || state.queued || this.#manual.some((m) => m.jobId === job.id)) {
			return { ok: false, message: `${job.name} already has a run` }
		}
		this.#manual.push({ jobId: job.id, runId: generateScheduleRunId() })
		if (this.#draining) {
			// This daemon starts nothing more and its memory goes with it: the run
			// is left queued on disk, for the daemon that takes over.
			this.#persistManual()
			return {
				ok: true,
				message: `${job.name} queued; the scheduler is restarting for an upgrade and starts it once it is back`,
			}
		}
		this.wake()
		return { ok: true, message: `${job.name} queued` }
	}

	/**
	 * Move every manual run still waiting in memory (deferred by the cap or a
	 * busy folder lane) to `state.queued` on disk. A daemon that stops
	 * dispatching (a drain) or exits keeps no memory, and the CLI has already
	 * told the operator the run is queued; the daemon that takes over starts
	 * it from disk under the same run id.
	 */
	#persistManual(): void {
		for (const manual of this.#manual.splice(0)) {
			try {
				const state = readState(this.#o.paths, manual.jobId)
				if (state.activeRun || state.queued) {
					this.#o.log.warn('manual run dropped; the job already has a run', {
						'namzu.schedule.job_id': manual.jobId,
						'namzu.schedule.run_id': manual.runId,
					})
					continue
				}
				const at = new Date(this.#now()).toISOString()
				writeState(this.#o.paths, {
					...state,
					queued: {
						key: `${MANUAL_KEY_PREFIX}${manual.runId}`,
						scheduledFor: at,
						trigger: 'manual',
						queuedAt: at,
					},
				})
			} catch (error) {
				this.#o.log.error('manual run could not be queued on disk', {
					'namzu.schedule.job_id': manual.jobId,
					'namzu.schedule.run_id': manual.runId,
					'exception.message': error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	#heartbeat(): void {
		try {
			writeJsonAtomic(this.#o.paths.heartbeat, {
				v: 1,
				kind: 'schedule-heartbeat',
				at: new Date(this.#now()).toISOString(),
				pid: process.pid,
				epoch: this.#o.epoch,
				version: this.#o.version,
				standby: this.#standby,
				draining: this.#draining,
				runsInFlight: this.#running.size,
				notifications: this.#o.notificationBackend ?? 'unknown',
			})
		} catch {}
	}

	#observeClock(): void {
		const wall = this.#now()
		const mono = this.#mono()
		const wallDelta = wall - this.#lastWall
		const monoDelta = mono - this.#lastMono
		if (wallDelta - monoDelta > GAP_MS) {
			this.#observedGap = {
				from: new Date(this.#lastWall),
				to: new Date(wall),
				kind: monoDelta < wallDelta / 2 ? 'asleep' : 'clock-forward',
			}
			this.#o.log.info('scheduler observed a clock gap', {
				'namzu.schedule.gap_ms': wallDelta - monoDelta,
				'namzu.schedule.gap_kind': this.#observedGap.kind,
			})
		} else if (monoDelta - wallDelta > GAP_MS) {
			this.#observedGap = {
				from: new Date(this.#lastWall),
				to: new Date(wall),
				kind: 'clock-backward',
			}
			this.#o.log.info('scheduler observed the clock going back', {
				'namzu.schedule.gap_ms': monoDelta - wallDelta,
			})
		}
		this.#lastWall = wall
		this.#lastMono = mono
	}

	/** One pass: every job evaluated, the queue dispatched. Public for tests. */
	async tick(): Promise<void> {
		this.#observeClock()
		if (!this.#draining && this.#o.fingerprint() !== this.#startFingerprint) {
			this.#o.log.info('installed CLI changed; draining for a restart', {
				'namzu.schedule.epoch': this.#o.epoch,
			})
			this.#draining = true
			this.#persistManual()
		}
		const now = this.#now()
		const { jobs, errors } = listJobs(this.#o.paths)
		for (const error of errors) {
			this.#o.log.warn('scheduled job file unreadable', {
				'namzu.schedule.path': error.path,
				'exception.message': error.message,
			})
		}
		for (const job of jobs) {
			try {
				await this.#tickJob(job, now)
			} catch (error) {
				this.#o.log.error('scheduled job evaluation failed', {
					'namzu.schedule.job_id': job.id,
					'exception.message': error instanceof Error ? error.message : String(error),
				})
			}
		}
		this.#observedGap = undefined
		if (!this.#draining) await this.#dispatch(now)
		// A dispatch that was under way when the drain began may have handed a
		// deferred manual run back to memory.
		if (this.#draining) this.#persistManual()
		if (now - this.#lastHousekeeping > HOUSEKEEPING_MS) {
			this.#lastHousekeeping = now
			for (const job of jobs) {
				try {
					compactHistory(this.#o.paths, job.id, now)
					pruneClaims(this.#o.paths, job.id, job.catchUp.windowMs + CLAIM_RETENTION_EXTRA_MS, now)
				} catch {}
			}
			pruneDaemonLogs(this.#o.paths.daemonLog, new Date(now))
		}
		this.#heartbeat()
	}

	async #notice(
		kind: NoticeKind,
		job: ScheduleJob,
		extra: Parameters<typeof noticeText>[2],
	): Promise<void> {
		if (!this.#o.notifications) return
		const flags = job.notify
		const wanted =
			kind === 'finished'
				? flags.finished
				: kind === 'awaiting-approval'
					? flags.awaitingApproval
					: kind === 'catch-up'
						? flags.finished || flags.failed
						: flags.failed || kind === 'held' || kind === 'needs-confirmation'
		if (!wanted) return
		// What needs the person is never throttled: each happens at most once
		// per run or per change, and a dropped one is never sent again. A park
		// right after a catch-up notice would otherwise sit unannounced until
		// its approval expired, with every later occurrence skipped.
		const always =
			kind === 'held' ||
			kind === 'needs-confirmation' ||
			kind === 'auto-paused' ||
			kind === 'awaiting-approval' ||
			kind === 'approval-expired'
		if (
			!always &&
			!admitNotification(join(this.#o.paths.daemon, 'notify.json'), job.id, this.#now())
		)
			return
		const text = noticeText(kind, job, extra)
		await this.#o.notify({ jobId: job.id, ...text })
		this.#o.log.info('scheduled run notification', {
			'namzu.schedule.job_id': job.id,
			'namzu.schedule.notice': kind,
		})
	}

	async #tickJob(loaded: ScheduleJob, now: number): Promise<void> {
		const paths = this.#o.paths
		let job = loaded
		let state = readState(paths, job.id)

		// A confirmed job whose file no longer matches its confirmation was
		// edited behind the CLI's back: hold it, say so once.
		if (job.state === 'active' && !confirmationHolds(job)) {
			job = updateJob(paths, job.id, job.revision, (j) => ({ ...j, state: 'pending-confirmation' }))
			appendHistory(paths, job.id, {
				v: 1,
				kind: 'job',
				at: new Date(now).toISOString(),
				action: 'tampered',
				by: 'daemon',
				detail: 'the job file changed outside namzu; it waits for confirmation',
			})
			state = { ...state, lastHoldNotice: jobSecurityDigest(job) }
			writeState(paths, state)
			await this.#notice('held', job, { at: new Date(now) })
		} else if (job.state === 'pending-confirmation') {
			const digest = jobSecurityDigest(job)
			if (state.lastHoldNotice !== digest) {
				state = { ...state, lastHoldNotice: digest }
				writeState(paths, state)
				await this.#notice('needs-confirmation', job, { at: new Date(now) })
			}
		}

		state = await this.#reconcile(job, state, now)
		job = readJob(paths, job.id) ?? job

		// A draining daemon does not evaluate. Evaluating would move
		// `lastEvaluatedAt` past an occurrence it cannot queue, so the daemon
		// that takes over would never see it: no run, no `missed`, and a
		// one-shot left active with nothing to fire. Left alone, the successor
		// evaluates from where this daemon stopped and runs it (late, as a
		// scheduled or catch-up run under the job's own policy).
		if (this.#draining) return

		const evaluationState: ScheduleEvaluationState = {
			...(state.lastEvaluatedAt ? { lastEvaluatedAt: state.lastEvaluatedAt } : {}),
			...(state.jobRevision !== undefined ? { jobRevision: state.jobRevision } : {}),
			...(state.activeRun
				? { activeRun: { status: state.activeRun.status } }
				: state.queued || this.#manual.some((m) => m.jobId === job.id)
					? { activeRun: { status: 'queued' as const } }
					: {}),
			...(state.quotaHoldUntil ? { quotaHoldUntil: state.quotaHoldUntil } : {}),
		}
		const decision = evaluateJob({
			job: {
				spec: job.schedule,
				state: job.state,
				catchUp: job.catchUp,
				createdAt: job.createdAt,
				updatedAt: job.updatedAt,
				revision: job.revision,
			},
			state: evaluationState,
			now: new Date(now),
			daemon: {
				startedAt: new Date(this.#startedAt),
				...(this.#observedGap ? { observedGap: this.#observedGap } : {}),
			},
			isClaimed: (key) => isClaimed(paths, job.id, key),
		})
		const at = new Date(now).toISOString()
		for (const skip of decision.skip) {
			appendHistory(paths, job.id, {
				v: 1,
				kind: 'skip',
				at,
				scheduledFor: skip.scheduledFor.toISOString(),
				reason: skip.reason,
				count: skip.count,
			})
		}
		if (decision.missed) {
			appendHistory(paths, job.id, {
				v: 1,
				kind: 'missed',
				at,
				from: decision.missed.from.toISOString(),
				to: decision.missed.to.toISOString(),
				count: decision.missed.count,
				...(decision.missed.capped ? { capped: true } : {}),
				reason: decision.missed.reason,
				...(decision.fire ? { caughtUpBy: decision.fire.key } : {}),
			})
		}
		let next: ScheduleJobState = withoutUndefined({
			...state,
			lastEvaluatedAt: decision.nextState.lastEvaluatedAt.toISOString(),
			jobRevision: decision.nextState.jobRevision,
			nextFireAt: decision.nextState.nextFireAt?.toISOString(),
			quotaHoldUntil:
				state.quotaHoldUntil && Date.parse(state.quotaHoldUntil) > now
					? state.quotaHoldUntil
					: undefined,
		})
		if (decision.fire) {
			next = {
				...next,
				queued: {
					key: decision.fire.key,
					scheduledFor: decision.fire.scheduledFor.toISOString(),
					trigger: decision.fire.trigger,
					queuedAt: at,
				},
			}
			if (decision.fire.trigger === 'catch-up') {
				await this.#notice('catch-up', job, {
					at: new Date(now),
					scheduledFor: decision.fire.scheduledFor,
					...(decision.missed ? { missed: decision.missed.count } : {}),
				})
			}
		}
		writeState(paths, next)
		if (decision.jobTransition && decision.jobTransition !== job.state) {
			const transition = decision.jobTransition
			// A one-shot that fired completes once its run is dispatched; one
			// that expired is done now.
			if (transition === 'expired' || !decision.fire) {
				updateJob(paths, job.id, job.revision, (j) => ({ ...j, state: transition }))
				appendHistory(paths, job.id, { v: 1, kind: 'job', at, action: transition, by: 'daemon' })
			}
		}
	}

	/**
	 * Record how a run this daemon did not start has ended — a foreground
	 * `schedule run-now` — exactly as a run it started is recorded. False,
	 * and nothing written, when the job's state no longer names that run (a
	 * daemon that adopted it recorded it first).
	 */
	async finalizeRun(jobId: string, runId: string, result: ScheduleRunResult): Promise<boolean> {
		const job = readJob(this.#o.paths, jobId)
		const run = readState(this.#o.paths, jobId).activeRun
		if (!job || run?.runId !== runId) return false
		this.#finalize(job, run, result, this.#now())
		await this.settled()
		return true
	}

	/**
	 * Settle the job's run in progress if its process is gone, as a tick
	 * would, without evaluating the schedule. For a foreground `run-now`
	 * finding a run no scheduler is left to settle.
	 */
	async reconcileJob(jobId: string): Promise<ScheduleJobState | undefined> {
		const job = readJob(this.#o.paths, jobId)
		if (!job) return undefined
		const state = await this.#reconcile(job, readState(this.#o.paths, jobId), this.#now())
		await this.settled()
		return state
	}

	/** Finalise or adopt the job's run in progress, if it has one. */
	async #reconcile(
		job: ScheduleJob,
		state: ScheduleJobState,
		now: number,
	): Promise<ScheduleJobState> {
		// A run adopted earlier that the job no longer names was recorded by
		// someone else (a foreground `run-now` finishing): stop counting it.
		for (const [runId, tracked] of this.#running) {
			if (tracked.jobId === job.id && !tracked.run && state.activeRun?.runId !== runId)
				this.#running.delete(runId)
		}
		const run = state.activeRun
		if (!run) return state
		const tracked = this.#running.get(run.runId)
		if (tracked?.run) return state
		const result = readRunResult(this.#o.paths, job.id, run.runId)
		if (run.status === 'running') {
			if (isFinal(result)) return this.#finalize(job, run, result as ScheduleRunResult, now)
			const slug = result?.projectSlug ?? run.projectSlug
			const sessionId = result?.sessionId ?? run.sessionId
			const ref =
				slug && sessionId ? { home: this.#o.paths.home, projectSlug: slug, sessionId } : undefined
			if (ref && (await sessionLeaseLive(ref, now))) {
				this.#running.set(run.runId, {
					jobId: job.id,
					runId: run.runId,
					folder: job.folder.canonical,
					writes: allowsWrites(job.permissions),
				})
				return state
			}
			if (!ref && now - Date.parse(run.startedAt) < START_GRACE_MS) {
				this.#running.set(run.runId, {
					jobId: job.id,
					runId: run.runId,
					folder: job.folder.canonical,
					writes: allowsWrites(job.permissions),
				})
				return state
			}
			this.#running.delete(run.runId)
			// The process is gone. The session log says how far the turn got.
			const facts = ref ? await sessionFacts(ref) : null
			if (facts?.activeTurn?.paused) {
				return this.#finalize(
					job,
					run,
					{
						...(result ?? this.#emptyResult(job, run)),
						status: 'awaiting-approval',
						exitCode: 0,
						turnId: facts.activeTurn.turnId,
						...(ref ? { sessionId: ref.sessionId, projectSlug: ref.projectSlug } : {}),
					},
					now,
				)
			}
			const outcome =
				facts && !facts.activeTurn ? turnOutcome(facts, run.turnId ?? result?.turnId) : undefined
			return this.#finalize(
				job,
				run,
				{
					...(result ?? this.#emptyResult(job, run)),
					status: outcome?.status ?? 'interrupted',
					exitCode: outcome?.status === 'completed' ? 0 : 1,
					reason:
						outcome?.reason ?? 'the run stopped without recording a result (its process ended)',
				},
				now,
			)
		}
		// Parked on a decision.
		if (!run.sessionId || !run.projectSlug) {
			return this.#finalize(
				job,
				run,
				{ ...this.#emptyResult(job, run), status: 'interrupted', exitCode: 1 },
				now,
			)
		}
		const ref = { home: this.#o.paths.home, projectSlug: run.projectSlug, sessionId: run.sessionId }
		const facts = await sessionFacts(ref)
		if (!facts) {
			return this.#finalize(
				job,
				run,
				{
					...this.#emptyResult(job, run),
					status: 'interrupted',
					exitCode: 1,
					reason: 'the parked session is gone',
				},
				now,
			)
		}
		const active = facts.activeTurn
		if (active && active.turnId === run.turnId) {
			if (!active.paused) return state // someone resumed it; wait for it to settle
			const parkedAt = Date.parse(run.parkedAt ?? run.startedAt)
			if (now - parkedAt > job.approvalTtlMs && !(await sessionLeaseLive(ref, now))) {
				try {
					await abandonParkedTurn(ref, active.turnId, 'Scheduled run: approval expired')
				} catch (error) {
					this.#o.log.warn('could not abandon an expired park', {
						'namzu.schedule.job_id': job.id,
						'exception.message': error instanceof Error ? error.message : String(error),
					})
					return state
				}
				const expired = this.#finalize(
					job,
					run,
					{
						...this.#emptyResult(job, run),
						status: 'approval-expired',
						exitCode: 1,
						reason: 'nobody answered the approval in time; the turn was abandoned',
					},
					now,
				)
				await this.#notice('approval-expired', job, { at: new Date(now) })
				return expired
			}
			return state
		}
		if (active) return state
		const outcome = turnOutcome(facts, run.turnId)
		if (!outcome) return state
		return this.#finalize(
			job,
			run,
			{
				...this.#emptyResult(job, run),
				status: outcome.status,
				exitCode: outcome.status === 'completed' ? 0 : 1,
				...(outcome.reason ? { reason: outcome.reason } : {}),
			},
			now,
		)
	}

	#emptyResult(job: ScheduleJob, run: ActiveRun): ScheduleRunResult {
		return {
			v: 1,
			kind: 'schedule-run-result',
			runId: run.runId,
			jobId: job.id,
			status: 'interrupted',
			exitCode: 1,
			startedAt: run.startedAt,
			...(run.sessionId ? { sessionId: run.sessionId } : {}),
			...(run.projectSlug ? { projectSlug: run.projectSlug } : {}),
			...(run.turnId ? { turnId: run.turnId } : {}),
		}
	}

	/** Record how a run ended, update counters, notify. Returns the new state (already written). */
	#finalize(
		job: ScheduleJob,
		run: ActiveRun,
		result: ScheduleRunResult,
		now: number,
	): ScheduleJobState {
		const paths = this.#o.paths
		const at = new Date(now).toISOString()
		const status: ScheduleRunStatus = result.status === 'running' ? 'interrupted' : result.status
		this.#running.delete(run.runId)
		appendRunRecord(paths, job.id, run, result, at)
		const current = readState(paths, job.id)
		const failed =
			status === 'failed' ||
			status === 'blocked-config' ||
			status === 'timed-out' ||
			status === 'interrupted' ||
			status === 'approval-expired'
		const counters = {
			runs: current.counters.runs + (status === 'awaiting-approval' ? 0 : 1),
			failures: current.counters.failures + (failed ? 1 : 0),
			failureStreak: failed
				? current.counters.failureStreak + 1
				: status === 'completed'
					? 0
					: current.counters.failureStreak,
		}
		const quotaHold =
			status === 'failed' &&
			result.retryAfterMs !== undefined &&
			result.retryAfterMs > job.budget.waitForProviderMs
				? new Date(now + result.retryAfterMs).toISOString()
				: current.quotaHoldUntil
		let next: ScheduleJobState
		if (status === 'awaiting-approval') {
			next = withoutUndefined({
				...current,
				counters,
				activeRun: withoutUndefined({
					...run,
					status: 'awaiting-approval' as const,
					sessionId: result.sessionId ?? run.sessionId,
					projectSlug: result.projectSlug ?? run.projectSlug,
					turnId: result.turnId ?? run.turnId,
					parkedAt: run.parkedAt ?? at,
				}),
			})
		} else {
			next = withoutUndefined({
				...current,
				counters,
				activeRun: undefined,
				quotaHoldUntil: quotaHold,
				lastRun: withoutUndefined({
					runId: run.runId,
					scheduledFor: run.scheduledFor,
					status,
					endedAt: result.endedAt ?? at,
					sessionId: result.sessionId,
				}),
			})
		}
		// The same failure is told once; a success clears it.
		let incident = next.lastIncident
		let tell: NoticeKind | undefined
		if (status === 'completed') {
			incident = undefined
			tell = 'finished'
		} else if (status === 'awaiting-approval') {
			tell = 'awaiting-approval'
		} else if (failed && status !== 'approval-expired') {
			const signature = failureSignature(status, result.reason)
			if (incident?.signature !== signature) {
				tell =
					status === 'blocked-config'
						? 'blocked-config'
						: status === 'timed-out'
							? 'timed-out'
							: status === 'interrupted'
								? 'interrupted'
								: 'failed'
				incident = { signature, at }
			}
		}
		next = withoutUndefined({ ...next, lastIncident: incident })
		writeState(paths, next)

		// A failing job pauses itself rather than failing every tick forever.
		const pauseAfter = job.failurePolicy.pauseAfterFailures
		let autoPaused = false
		if (failed && pauseAfter > 0 && counters.failureStreak >= pauseAfter) {
			const latest = readJob(paths, job.id)
			if (latest && latest.state === 'active') {
				updateJob(paths, job.id, latest.revision, (j) => ({
					...j,
					state: 'paused',
					pausedAt: at,
					pausedBy: 'auto-failure-streak',
				}))
				appendHistory(paths, job.id, {
					v: 1,
					kind: 'job',
					at,
					action: 'paused',
					by: 'auto-failure-streak',
					detail: `${counters.failureStreak} failed runs in a row`,
				})
				autoPaused = true
			}
		}
		// A one-shot that ran is complete.
		if (job.schedule.kind === 'at' && status !== 'awaiting-approval' && run.trigger !== 'manual') {
			const latest = readJob(paths, job.id)
			if (latest && latest.state === 'active') {
				updateJob(paths, job.id, latest.revision, (j) => ({ ...j, state: 'completed' }))
				appendHistory(paths, job.id, { v: 1, kind: 'job', at, action: 'completed', by: 'daemon' })
			}
		}
		const notices: Promise<void>[] = []
		if (tell) {
			notices.push(
				this.#notice(tell, job, {
					at: new Date(now),
					...(result.summary ? { summary: result.summary } : {}),
				}),
			)
		}
		if (autoPaused)
			notices.push(
				this.#notice('auto-paused', job, { at: new Date(now), failures: counters.failureStreak }),
			)
		if (status === 'completed') {
			notices.push(
				archiveOldRuns(paths, job, next).then(
					(archived) => {
						if (archived.length > 0) {
							const latest = readState(paths, job.id)
							writeState(paths, {
								...latest,
								archivedSessions: [...(latest.archivedSessions ?? []), ...archived].slice(-200),
							})
						}
					},
					() => undefined,
				),
			)
		}
		this.#finalizing.push(Promise.allSettled(notices).then(() => undefined))
		this.#o.log.info('scheduled run recorded', {
			'namzu.schedule.job_id': job.id,
			'namzu.schedule.run_id': run.runId,
			'namzu.schedule.status': status,
		})
		return next
	}

	/** Start queued runs, oldest first, within the cap and the folder lanes. */
	async #dispatch(now: number): Promise<void> {
		const paths = this.#o.paths
		const queue: { job: ScheduleJob; state: ScheduleJobState; manual?: string }[] = []
		for (const job of listJobs(paths).jobs) {
			const state = readState(paths, job.id)
			if (state.queued) queue.push({ job, state })
		}
		queue.sort((a, b) =>
			(a.state.queued?.queuedAt ?? '').localeCompare(b.state.queued?.queuedAt ?? ''),
		)
		for (const manual of this.#manual.splice(0)) {
			const job = readJob(paths, manual.jobId)
			if (job) queue.push({ job, state: readState(paths, job.id), manual: manual.runId })
		}
		for (const entry of queue) {
			const { job } = entry
			const queued = entry.state.queued
			if (!(await this.#stillOwner())) {
				this.#o.log.warn('scheduler fenced out; not dispatching', {
					'namzu.schedule.epoch': this.#o.epoch,
				})
				return
			}
			const latest = readJob(paths, job.id)
			if (!latest || latest.state !== 'active' || !confirmationHolds(latest)) {
				if (queued) writeState(paths, withoutUndefined({ ...entry.state, queued: undefined }))
				continue
			}
			const writes = allowsWrites(latest.permissions)
			const busyLane =
				writes &&
				[...this.#running.values()].some((t) => t.writes && t.folder === latest.folder.canonical)
			if (this.#running.size >= this.#o.maxConcurrentRuns || busyLane) {
				this.#delayReasons.set(job.id, busyLane ? 'folder-busy' : 'concurrency-cap')
				if (entry.manual) this.#manual.push({ jobId: job.id, runId: entry.manual })
				continue
			}
			const delayReason = this.#delayReasons.get(job.id)
			this.#delayReasons.delete(job.id)
			// A manual run queued on disk (during a drain) keeps the run id its key names.
			const queuedManual =
				!entry.manual && queued?.trigger === 'manual' && queued.key.startsWith(MANUAL_KEY_PREFIX)
					? queued.key.slice(MANUAL_KEY_PREFIX.length)
					: undefined
			const runId = entry.manual ?? queuedManual ?? generateScheduleRunId()
			const key = entry.manual ? `${MANUAL_KEY_PREFIX}${runId}` : (queued?.key as string)
			const trigger: ScheduleRunTrigger = entry.manual ? 'manual' : (queued?.trigger ?? 'scheduled')
			if (
				!claimOccurrence(paths, {
					jobId: job.id,
					key,
					runId,
					daemonEpoch: this.#o.epoch,
					at: new Date(now).toISOString(),
				})
			) {
				// Somebody already started this occurrence.
				if (queued)
					writeState(paths, withoutUndefined({ ...readState(paths, job.id), queued: undefined }))
				continue
			}
			const delayedMs =
				queued && trigger !== 'manual' ? Math.max(0, now - Date.parse(queued.queuedAt)) : 0
			const run: ActiveRun = withoutUndefined({
				runId,
				key,
				trigger,
				scheduledFor: trigger === 'manual' ? undefined : queued?.scheduledFor,
				startedAt: new Date(now).toISOString(),
				daemonEpoch: this.#o.epoch,
				status: 'running' as const,
				delayedMs: delayedMs >= 1_000 ? delayedMs : undefined,
				delayReason: delayedMs >= 1_000 ? (delayReason ?? 'concurrency-cap') : undefined,
			})
			writeState(
				paths,
				withoutUndefined({ ...readState(paths, job.id), queued: undefined, activeRun: run }),
			)
			appendHistory(paths, job.id, {
				v: 1,
				kind: 'run',
				at: run.startedAt,
				runId,
				key,
				trigger,
				...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
				startedAt: run.startedAt,
				...(run.delayedMs
					? { delayedMs: run.delayedMs, delayReason: run.delayReason ?? 'concurrency-cap' }
					: {}),
				status: 'running',
			})
			let spawned: SpawnedRun
			try {
				spawned = this.#o.spawnFire({
					job: latest,
					runId,
					key,
					trigger,
					...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
					epoch: this.#o.epoch,
				})
			} catch (error) {
				this.#finalize(
					latest,
					run,
					{
						...this.#emptyResult(latest, run),
						status: 'failed',
						exitCode: 1,
						reason: `the run could not be started: ${error instanceof Error ? error.message : String(error)}`,
					},
					now,
				)
				continue
			}
			this.#running.set(runId, {
				jobId: job.id,
				runId,
				folder: latest.folder.canonical,
				writes,
				run: spawned,
			})
			this.#o.log.info('scheduled run started', {
				'namzu.schedule.job_id': job.id,
				'namzu.schedule.run_id': runId,
				'namzu.schedule.trigger': trigger,
			})
			void spawned.exited.then(() => {
				const tracked = this.#running.get(runId)
				if (tracked) this.#running.set(runId, { ...tracked, run: undefined })
				const jobNow = readJob(paths, job.id) ?? latest
				const state = readState(paths, job.id)
				if (state.activeRun?.runId === runId) {
					const result = readRunResult(paths, job.id, runId)
					this.#finalize(
						jobNow,
						state.activeRun,
						isFinal(result)
							? (result as ScheduleRunResult)
							: {
									...this.#emptyResult(jobNow, state.activeRun),
									...(result ?? {}),
									status: 'interrupted',
									exitCode: 1,
									reason: 'the run ended without recording a result',
								},
						this.#now(),
					)
				} else {
					this.#running.delete(runId)
					// The job was removed (`remove --force`) while this run went on:
					// nothing will ever settle it, so its end is written here, where
					// `prune` finds it.
					if (!readJob(paths, job.id)) {
						const result = readRunResult(paths, job.id, runId)
						appendRunRecord(
							paths,
							job.id,
							run,
							isFinal(result)
								? (result as ScheduleRunResult)
								: {
										...this.#emptyResult(latest, run),
										...(result ?? {}),
										status: 'interrupted',
										exitCode: 1,
										reason: 'the run ended without recording a result',
									},
							new Date(this.#now()).toISOString(),
						)
					}
				}
				this.wake()
			})
		}
	}

	/** For tests: wait until notifications and archiving started by finalisation are done. */
	async settled(): Promise<void> {
		await Promise.allSettled(this.#finalizing.splice(0))
	}
}

/** A manual run's occurrence key is this and its run id. */
export const MANUAL_KEY_PREFIX = 'manual-'

/**
 * Append the record of how a run ended (or parked) to its job's history. A
 * run still `running` is recorded `interrupted`: the record is final.
 */
export function appendRunRecord(
	paths: SchedulePaths,
	jobId: string,
	run: ActiveRun,
	result: ScheduleRunResult,
	at: string,
): void {
	const status: ScheduleRunStatus = result.status === 'running' ? 'interrupted' : result.status
	appendHistory(paths, jobId, {
		v: 1,
		kind: 'run',
		at,
		runId: run.runId,
		key: run.key,
		trigger: run.trigger,
		...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
		startedAt: run.startedAt,
		...(status === 'awaiting-approval' ? {} : { endedAt: result.endedAt ?? at }),
		...(run.delayedMs
			? { delayedMs: run.delayedMs, delayReason: run.delayReason ?? 'concurrency-cap' }
			: {}),
		...(result.sessionId ? { sessionId: result.sessionId } : {}),
		status,
		...(result.reason ? { reason: result.reason } : {}),
		exitCode: result.exitCode,
		...(result.summary ? { summary: result.summary } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.warnings ? { warnings: result.warnings } : {}),
	})
}

/** Where `schedule stop` leaves its request. See `ScheduleDaemon#stopRequested`. */
export function stopRequestPath(paths: SchedulePaths): string {
	return join(paths.daemon, 'stop.json')
}

/** Ask every daemon of this home, owner or standby, to stop; or clear the request. */
export function requestStop(paths: SchedulePaths, stop: boolean): void {
	if (stop)
		writeJsonAtomic(stopRequestPath(paths), {
			v: 1,
			kind: 'schedule-stop',
			at: new Date().toISOString(),
		})
	else rmSync(stopRequestPath(paths), { force: true })
}

/** Spawn `node <bin> schedule __fire …` with its output going to a log file, not a pipe. */
export function spawnFireProcess(options: {
	readonly node: string
	readonly bin: string
	readonly paths: SchedulePaths
	readonly env: NodeJS.ProcessEnv
}): (request: FireSpawnRequest) => SpawnedRun {
	return (request) => {
		const logPath = options.paths.runLog(request.job.id, request.runId)
		ensureDir(dirname(logPath))
		writeFileSync(logPath, '', { flag: 'a', mode: PRIVATE_FILE_MODE })
		const fd = openSync(logPath, 'a', PRIVATE_FILE_MODE)
		let child: ChildProcess
		try {
			child = spawn(
				options.node,
				[
					options.bin,
					'schedule',
					'__fire',
					'--home',
					options.paths.home,
					'--job',
					request.job.id,
					'--run',
					request.runId,
					'--key',
					request.key,
					'--revision',
					String(request.job.revision),
					'--trigger',
					request.trigger,
					...(request.scheduledFor ? ['--scheduled-for', request.scheduledFor] : []),
					'--epoch',
					request.epoch,
				],
				{
					cwd: request.job.folder.canonical,
					env: childEnvironment(options.env, options.paths.home),
					stdio: ['ignore', fd, fd],
					detached: process.platform !== 'win32',
					windowsHide: true,
				},
			)
		} finally {
			closeSync(fd)
		}
		const exited = new Promise<number | null>((resolve) => {
			child.once('exit', (code) => resolve(code))
			child.once('error', () => resolve(null))
		})
		child.unref()
		return {
			exited,
			terminate: () => {
				try {
					child.kill('SIGTERM')
				} catch {}
			},
		}
	}
}

/**
 * The CLI as installed, cheaply: its version file, its entry point and the
 * scheduler's own modules, by size and time. An npm install rewrites every
 * file; a rebuild rewrites the modules that changed.
 */
export function installedFingerprint(bin: string): () => string {
	const dist = dirname(bin)
	const watched = [
		join(dist, '..', 'package.json'),
		bin,
		join(dist, 'schedule', 'daemon', 'daemon.js'),
		join(dist, 'schedule', 'fire', 'fire.js'),
	]
	return () => {
		const parts: string[] = []
		for (const path of watched) {
			try {
				const st = statSync(path)
				parts.push(`${st.size}:${st.mtimeMs}`)
			} catch {
				parts.push('missing')
			}
		}
		return parts.join('|')
	}
}
