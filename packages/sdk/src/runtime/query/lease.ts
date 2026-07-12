import type { RunDiskStore } from '../../store/run/disk.js'
import type { RunId } from '../../types/ids/index.js'
import {
	DEFAULT_RUN_LEASE_HEARTBEAT_MS,
	DEFAULT_RUN_LEASE_TTL_MS,
	type RunLease,
	type RunLeaseOptions,
} from '../../types/run/lease.js'
import type { Logger } from '../../utils/logger.js'

export interface RunLeaseHolderConfig extends RunLeaseOptions {
	runId: RunId
	store: RunDiskStore
	log: Logger
	/**
	 * Called when the heartbeat discovers the run has been taken over.
	 *
	 * A segment that has lost its lease is doing work nobody will accept: every write it
	 * makes from here is refused by the fence. It should stop, and `query()` uses this to
	 * abort the run's controller — which is the difference between a stalled segment that
	 * quietly wastes a provider call and one that wastes the rest of the run.
	 */
	onLost: (error: unknown) => void
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
	private constructor(
		private readonly config: RunLeaseHolderConfig,
		private lease: RunLease,
		private timer: NodeJS.Timeout,
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
				void holder.heartbeat()
			}, heartbeatMs),
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

	private async heartbeat(): Promise<void> {
		try {
			this.lease = await this.config.store.renewLease()
		} catch (err) {
			clearInterval(this.timer)
			this.config.log.error(
				'Lost this run’s lease — it was taken over while this segment was running. Every write from here is fenced off; stopping.',
				{
					runId: this.config.runId,
					token: this.lease.token,
					error: err instanceof Error ? err.message : String(err),
				},
			)
			this.config.onLost(err)
		}
	}

	/**
	 * Hand the run back. Called on every exit from the segment — parked, finished, failed
	 * — because a run whose lease is still outstanding is a run nobody may resume until
	 * its TTL burns down, and a *parked* run is meant to be resumable at once.
	 *
	 * Never throws: a release that fails must not turn a completed run into a failed one.
	 * The worst case is that the lease expires on its own, one TTL later.
	 */
	async release(): Promise<void> {
		clearInterval(this.timer)
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
