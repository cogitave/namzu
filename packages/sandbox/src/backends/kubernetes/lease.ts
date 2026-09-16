/**
 * Lease renewal for an acquired kubernetes sandbox.
 *
 * Acquire stamps an ABSOLUTE `shutdownTime` (now + `claimTtlSeconds`) plus
 * `shutdownPolicy: Delete` onto every object it creates. That is the leak
 * guard: a host that dies mid-run costs the cluster one expiry rather than a
 * sandbox that lives forever. It is also, unrenewed, a deadline on the RUN —
 * a session that outlives the TTL has its pod deleted underneath it, mid
 * command, with no error the host can attribute to anything.
 *
 * The two requirements are not in tension, they just need a second half:
 * a live handle renews its own lease, and a dead host stops renewing. So
 * this timer is owned by the Sandbox handle, and `destroy()` stops it.
 *
 * ## The shape of the timer
 *
 * One `setTimeout` chained per tick, never `setInterval`: a renewal PATCH
 * that takes longer than the interval must not queue a second one behind
 * it. The interval is HALF the TTL, so a single failed tick still leaves a
 * whole half-TTL of headroom for the next one to succeed, and it is
 * jittered ±10% so a hundred handles acquired in the same second do not
 * PATCH the API server in the same millisecond forever after.
 *
 * The timer is `unref`'d: a host process that has finished its work should
 * exit, not linger because a sandbox handle is still counting. A handle
 * nobody destroyed then expires on the cluster's clock exactly as an
 * abandoned one does, which is the behaviour the TTL exists for.
 *
 * ## Every tick is bounded
 *
 * A renewal that FAILS is survivable — it is reported and retried with half
 * a TTL of headroom. A renewal that HANGS is not: the next tick is scheduled
 * only after the current one settles, so a PATCH that never answers parks
 * the loop forever, reports nothing, and lets the lease expire in silence —
 * precisely the defect this file exists to close, moved onto the failure
 * path. An API server that accepts a connection and then never responds is
 * an ordinary cluster event, so each PATCH runs under its own deadline: it
 * aborts the request through the signal the client already takes, and an
 * expiry is then just another reported failure that retries on the next
 * tick.
 *
 * ## What each outcome means
 *
 *  - Success → the object's expiry moves a full TTL into the future.
 *  - Any error, a tick that ran out of time included → reported to
 *    `onRenewalError` and RETRIED on the next tick. A transient API blip
 *    must not tear down a working sandbox, and there is still half a TTL of
 *    headroom.
 *  - Already gone (404/410) → the object this handle owns no longer exists.
 *    Nothing will bring it back, so the loop stops and the handle is marked
 *    gone; every later call fails with a named error instead of dialing an
 *    address whose pod the controller has already deleted.
 */

import { OperationDeadline } from '../readiness.js'
import { KubernetesAlreadyGoneError } from './k8s-client.js'

/** How far each tick pushes the expiry, and how often ticks happen. */
export interface LeaseRenewalOptions {
	/** The same TTL acquire stamped. Each tick sets `now + ttlSeconds`. */
	readonly ttlSeconds: number
	/**
	 * Send the merge patch. Rejects with whatever the client rejects with.
	 *
	 * The `signal` is the tick's own deadline and IS passed on every call —
	 * an implementation that drops it still gets abandoned on time, but its
	 * socket then stays open until the peer or the OS closes it.
	 */
	readonly renew: (shutdownTime: string, signal?: AbortSignal) => Promise<void>
	/** Called once, when the renewed object turns out to be gone. */
	readonly onGone: () => void
	/**
	 * Every renewal failure that is not "already gone". `@namzu/sandbox` has
	 * no logger of its own and reads none from module scope, so a diagnostic
	 * this package cannot print is handed to the caller that can.
	 */
	readonly onRenewalError?: (error: unknown) => void
	/**
	 * Base interval between ticks. Defaults to half the TTL. Present so a
	 * test can drive many ticks in a few milliseconds without pretending a
	 * sub-second TTL is a realistic configuration.
	 */
	readonly intervalMs?: number
	/**
	 * How long ONE renewal PATCH may take before it is abandoned and retried.
	 * Defaults to a quarter of the interval, capped at
	 * {@link MAX_RENEWAL_TIMEOUT_MS} — a fraction rather than the whole
	 * interval so that a stalled API server still leaves the loop several
	 * attempts inside the half-TTL of headroom.
	 */
	readonly patchTimeoutMs?: number
	/** Deterministic jitter for tests. Defaults to `Math.random`. */
	readonly random?: () => number
}

/**
 * The ceiling on one renewal PATCH. A write to the API server that has not
 * answered in half a minute is not going to; at the one-hour default TTL the
 * derived quarter-interval would otherwise be 7.5 minutes of silence.
 */
const MAX_RENEWAL_TIMEOUT_MS = 30_000

/** ±10%: enough to spread a synchronised fleet, far too little to matter
 * against a half-TTL of headroom. */
const JITTER_FRACTION = 0.1

export function jitteredInterval(baseMs: number, random: () => number): number {
	const factor = 1 - JITTER_FRACTION + random() * (2 * JITTER_FRACTION)
	// Never zero, whatever a caller passes: a zero-delay chain would spin.
	return Math.max(1, Math.round(baseMs * factor))
}

/**
 * The renewal loop. Start it when the handle is handed out, stop it on
 * `destroy()`. Both are idempotent.
 */
export class KubernetesLeaseRenewal {
	private timer: ReturnType<typeof setTimeout> | undefined
	private stopped = false
	private started = false
	private readonly baseIntervalMs: number
	private readonly patchTimeoutMs: number
	private readonly random: () => number

	constructor(private readonly options: LeaseRenewalOptions) {
		this.baseIntervalMs = options.intervalMs ?? Math.max(1, (options.ttlSeconds * 1_000) / 2)
		this.patchTimeoutMs =
			options.patchTimeoutMs ??
			Math.max(1, Math.min(MAX_RENEWAL_TIMEOUT_MS, Math.round(this.baseIntervalMs / 4)))
		this.random = options.random ?? Math.random
	}

	/**
	 * The loop is alive: it has been started and not stopped. Deliberately
	 * NOT "a timer is pending" — `tick()` clears the timer before it awaits,
	 * so a liveness check written that way reads false for the whole duration
	 * of an in-flight renewal and would quietly pass against a loop that had
	 * parked forever inside one.
	 */
	get active(): boolean {
		return !this.stopped && this.started
	}

	start(): void {
		if (this.stopped || this.timer !== undefined) return
		this.started = true
		this.schedule()
	}

	stop(): void {
		this.stopped = true
		if (this.timer !== undefined) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}

	private schedule(): void {
		if (this.stopped) return
		const timer = setTimeout(
			() => {
				void this.tick()
			},
			jitteredInterval(this.baseIntervalMs, this.random),
		)
		// A pending renewal must never be the reason a host process stays up.
		timer.unref?.()
		this.timer = timer
	}

	/** Exposed for tests: one renewal attempt plus its scheduling decision. */
	async tick(): Promise<void> {
		this.timer = undefined
		if (this.stopped) return
		const shutdownTime = new Date(Date.now() + this.options.ttlSeconds * 1_000).toISOString()
		try {
			// On its own clock: the next tick is scheduled only once this one
			// settles, so an unbounded PATCH that never answers would park the
			// loop permanently and let the lease expire with nothing reported.
			// The deadline aborts the request and hands the expiry to the same
			// report-and-retry path every other failure takes.
			await new OperationDeadline(this.patchTimeoutMs, 'kubernetes lease renewal').run(
				async (signal) => await this.options.renew(shutdownTime, signal),
			)
		} catch (error) {
			if (error instanceof KubernetesAlreadyGoneError) {
				this.stop()
				this.options.onGone()
				return
			}
			// Everything else is transient until proven otherwise: report it
			// and try again on the next tick, which is still half a TTL
			// before anything expires.
			this.options.onRenewalError?.(error)
		}
		this.schedule()
	}
}
