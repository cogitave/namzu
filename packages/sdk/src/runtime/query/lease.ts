import type { RunDiskStore } from '../../store/run/disk.js'
import type { RunId } from '../../types/ids/index.js'
import {
	DEFAULT_RUN_LEASE_ABANDON_MS,
	DEFAULT_RUN_LEASE_HEARTBEAT_MS,
	DEFAULT_RUN_LEASE_TTL_MS,
	type RunLease,
	RunLeaseExpiredError,
	RunLeaseLostError,
	type RunLeaseOptions,
	RunSegmentAbandonedError,
} from '../../types/run/lease.js'
import type { Logger } from '../../utils/logger.js'

export interface RunLeaseHolderConfig extends RunLeaseOptions {
	runId: RunId
	store: RunDiskStore
	log: Logger
	/**
	 * Called when the segment stops owning the run — taken over, expired, or abandoned by
	 * its consumer.
	 *
	 * A segment that has lost its lease is doing work nobody will accept: every write it
	 * makes from here is refused by the fence. It should stop, and `query()` uses this to
	 * abort the run's controller — which is the difference between a stalled segment that
	 * quietly wastes a provider call and one that wastes the rest of the run.
	 *
	 * The error is always a {@link RunLeaseLostError} (or a subclass of it), and that is
	 * load-bearing: `query()` routes exactly that family to a SILENT exit. A segment that no
	 * longer owns the run has no standing to declare it failed.
	 */
	onLost: (error: RunLeaseLostError) => void
	/**
	 * Is nobody consuming this run's events any more?
	 *
	 * The heartbeat is the only thing still running inside an abandoned generator, so the
	 * heartbeat is what has to ask. See {@link DEFAULT_RUN_LEASE_ABANDON_MS}.
	 */
	isAbandoned?: () => boolean
}

/**
 * Holds a run's lease for the duration of one segment, and renews it.
 *
 * The heartbeat is what separates "this segment is slow" from "this segment is dead", and
 * it is the reason a lease can expire at all: without a renewal, a TTL long enough to
 * survive a slow tool would be a TTL long enough to strand a crashed run for that long.
 *
 * `unref()` on the timer is not a detail — without it, a lease heartbeat would keep the
 * Node process alive after the run finished, and an embedder's CLI would simply not exit.
 */
export class RunLeaseHolder {
	private stopped = false
	private inFlight: Promise<void> | null = null
	private consecutiveFailures = 0

	private constructor(
		private readonly config: RunLeaseHolderConfig,
		private lease: RunLease,
		private timer: NodeJS.Timeout,
		private readonly abandonAfterMs: number,
	) {}

	static async acquire(config: RunLeaseHolderConfig): Promise<RunLeaseHolder> {
		const ttlMs = config.ttlMs ?? DEFAULT_RUN_LEASE_TTL_MS
		const lease = await config.store.acquireLease(config.runId, {
			ttlMs,
			holderId: config.holderId,
		})

		// Renew at least three times per TTL. A caller that asks for a heartbeat longer
		// than its own TTL is asking to be declared dead while alive, so the interval is
		// floored rather than trusted.
		const heartbeatMs = Math.max(
			1,
			Math.min(config.heartbeatMs ?? DEFAULT_RUN_LEASE_HEARTBEAT_MS, Math.floor(ttlMs / 3)),
		)

		const holder = new RunLeaseHolder(
			config,
			lease,
			setInterval(() => {
				// Kept, so `release()` can wait for it. `heartbeat()` handles its own errors;
				// the guard is here so a bug in it can never surface as an unhandled rejection
				// on a timer nobody is awaiting.
				holder.inFlight = holder.heartbeat().catch(() => undefined)
			}, heartbeatMs),
			config.abandonAfterMs ?? DEFAULT_RUN_LEASE_ABANDON_MS,
		)
		holder.timer.unref?.()

		config.log.debug('Run lease acquired', {
			runId: config.runId,
			token: lease.token,
			holderId: lease.holderId,
			ttlMs,
			heartbeatMs,
		})

		return holder
	}

	get token(): number {
		return this.lease.token
	}

	/**
	 * Renew, or find out we no longer own the run.
	 *
	 * **Only a {@link RunLeaseLostError} means the lease was lost.** Everything else is the
	 * filesystem having a bad moment, and treating those as a takeover is how a healthy,
	 * uncontended run gets durably failed: `renewLease()` can reject with `EMFILE` (an agent
	 * runtime under fd pressure), `ENOSPC`, a transient `EIO` — and a single one of those
	 * used to clear the interval, abort the controller, and mark the run `failed`, with the
	 * fence happily permitting the write because the segment still legitimately held the
	 * lease. There was no second attempt, because the interval was already gone.
	 *
	 * So a transient failure is logged and retried on the next tick. **The retry is bounded
	 * by the TTL, not by a count**, because the TTL is where the meaning is: from the moment
	 * `renewedAt + ttlMs` passes with no successful renewal, this lease reads `stale` to
	 * everybody else and another segment is entitled to take the run over. Continuing to
	 * drive past that point is driving a run we do not own. At the defaults (30s TTL, 10s
	 * heartbeat) that is three consecutive failures; change either number and the bound
	 * follows it, which is the property a hard-coded `3` would not have.
	 */
	private async heartbeat(): Promise<void> {
		if (this.stopped) return

		if (this.config.isAbandoned?.()) {
			await this.abandon()
			return
		}

		try {
			this.lease = await this.config.store.renewLease()
			this.consecutiveFailures = 0
			return
		} catch (err) {
			if (err instanceof RunLeaseLostError) {
				this.giveUp(
					err,
					'Lost this run’s lease — it was taken over while this segment was running. Every write from here is fenced off; stopping.',
				)
				return
			}

			this.consecutiveFailures++
			const expiresAt = this.lease.renewedAt + this.lease.ttlMs

			if (Date.now() < expiresAt) {
				this.config.log.warn(
					'Could not renew this run’s lease — retrying on the next heartbeat. The lease is still valid; nothing has taken the run.',
					{
						runId: this.config.runId,
						token: this.lease.token,
						consecutiveFailures: this.consecutiveFailures,
						validForMs: expiresAt - Date.now(),
						error: err instanceof Error ? err.message : String(err),
					},
				)
				return
			}

			this.giveUp(
				new RunLeaseExpiredError(
					this.config.runId,
					this.lease.token,
					this.consecutiveFailures,
					this.lease.renewedAt,
					this.lease.ttlMs,
				),
				'This run’s lease expired while renewals kept failing — it is no longer this segment’s to drive; stopping.',
			)
		}
	}

	private giveUp(error: RunLeaseLostError, message: string): void {
		this.stopped = true
		clearInterval(this.timer)
		this.config.log.error(message, {
			runId: this.config.runId,
			token: this.lease.token,
			error: error.message,
		})
		this.config.onLost(error)
	}

	/**
	 * Nobody is pulling this run's events. Give the run back.
	 *
	 * The lease is RELEASED rather than merely dropped, so the run is resumable at once
	 * instead of one TTL from now — and the store is DISOWNED rather than merely released,
	 * so a consumer that comes back and pulls one more event cannot resume writing to a run
	 * this segment has already handed over. A store with no lease is the control plane, and
	 * the control plane is unfenced.
	 */
	private async abandon(): Promise<void> {
		this.stopped = true
		clearInterval(this.timer)

		const error = new RunSegmentAbandonedError(
			this.config.runId,
			this.lease.token,
			this.abandonAfterMs,
		)
		this.config.log.error(
			'Nothing has pulled an event from this run’s generator for longer than the abandon window, and it is sitting at a yield waiting to hand one over. Releasing the lease so the run is not held for the life of the process.',
			{
				runId: this.config.runId,
				token: this.lease.token,
				abandonAfterMs: this.abandonAfterMs,
			},
		)

		try {
			await this.config.store.disownLease()
		} catch (err) {
			this.config.log.warn('Failed to give back an abandoned run’s lease — it will expire', {
				runId: this.config.runId,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		this.config.onLost(error)
	}

	/**
	 * Hand the run back. Called on every exit from the segment — parked, finished, failed
	 * — because a run whose lease is still outstanding is a run nobody may resume until
	 * its TTL burns down, and a *parked* run is meant to be resumable at once.
	 *
	 * **It waits for a heartbeat that is already in flight.** `clearInterval` cancels the
	 * next tick; it does nothing about the renewal that is halfway through `renewLease()`
	 * right now. That renewal completes AFTER the release, rewrites the lease file without
	 * `releasedAt`, and resurrects a lease no live segment holds — so for a full TTL the
	 * parked run reads `held`, every resume is refused `RunLeaseHeldError` on behalf of a
	 * process that has already exited, and an operator polling `readRunLease` sees a
	 * phantom segment. Awaiting it here is what makes "a parked run is resumable AT ONCE"
	 * true rather than usually-true.
	 *
	 * Never throws: a release that fails must not turn a completed run into a failed one.
	 * The worst case is that the lease expires on its own, one TTL later.
	 */
	async release(): Promise<void> {
		this.stopped = true
		clearInterval(this.timer)

		try {
			await this.inFlight
		} catch {
			// A heartbeat that failed on its way out has already been handled by `heartbeat`
			// itself. It must not stop the run from handing its lease back.
		}

		try {
			await this.config.store.releaseLease()
		} catch (err) {
			this.config.log.warn('Failed to release the run lease — it will expire on its own', {
				runId: this.config.runId,
				token: this.lease.token,
				ttlMs: this.lease.ttlMs,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
}
