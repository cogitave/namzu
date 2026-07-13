import type { RunId } from '../ids/index.js'

/**
 * How long a lease stays valid without a renewal.
 *
 * The number is a bet on two things at once, and it is the only honest way to pick one:
 *
 *   - **Too short** and a healthy segment loses its lease to a hiccup. Renewal is
 *     timer-driven, so the thing that starves it is the event loop — a long synchronous
 *     tool, a stop-the-world GC, a blocking `readFileSync` on a cold disk. 30s tolerates
 *     a 30-second stall, which is far beyond anything a healthy Node process does.
 *   - **Too long** and a crashed run is unrecoverable for that long: nobody may resume it
 *     until its lease is declared stale. 30s is the worst-case delay before an operator —
 *     or a retry — can pick a crashed run back up.
 *
 * There is no value that makes both problems go away, because a lease cannot distinguish
 * a dead holder from a slow one. That is not an implementation gap; it is the reason the
 * fencing token exists (see {@link RunLease.token}): the TTL decides *when we act*, and
 * the token makes it *safe to be wrong*.
 */
export const DEFAULT_RUN_LEASE_TTL_MS = 30_000

/**
 * How often a live holder renews. TTL/3 — two renewals may be lost (a GC pause, a
 * dropped timer) before the lease is declared stale.
 */
export const DEFAULT_RUN_LEASE_HEARTBEAT_MS = 10_000

/**
 * How long a segment may sit at a `yield` with nobody pulling before it is declared
 * ABANDONED and gives the run back.
 *
 * An async generator that its consumer simply drops — no `break`, no `.return()`, just a
 * lost reference — never runs its `finally`. Node does not run a generator's `finally` on
 * collection, so `query()`'s release never fires: the heartbeat goes on renewing the lease
 * every 10s forever, the run reads `held` to every operator and every resume, and it is
 * never resumable again. The timer's closure also retains the whole `RunContext`, so the
 * run's working set is pinned for the life of the process.
 *
 * The heartbeat is the only thing still running in that situation, so the heartbeat is
 * what has to notice. It can: a generator is either executing inside `next()` (alive) or
 * suspended at a `yield` waiting to be pulled (the consumer's turn). Suspended and unpulled
 * for this long is not a slow consumer, it is no consumer.
 *
 * 10× the TTL, and deliberately generous: the cost of being wrong is aborting a healthy
 * run, and the thing being bounded is a leak, not a correctness bug. Five minutes without
 * pulling a single event, while the run sits idle waiting to hand one over, is not a
 * consumer anybody is watching.
 */
export const DEFAULT_RUN_LEASE_ABANDON_MS = 300_000

/**
 * The right to DRIVE a run — held by exactly one segment of execution at a time.
 *
 * A "segment" is one pass through `query()`: the original run, or any later resume. The
 * run is the durable thing; segments come and go, and until ses_017 G1 nothing said
 * which one owned it. Two processes could drive `query({ resumeFromCheckpoint })` for one
 * run at the same time, both write `run.json` and `messages.json`, and the last writer
 * won — silently discarding the other's work, including tools it had already run.
 *
 * **A lease is not a claim.** The decision/execution claims
 * ({@link import('../hitl/index.js').DecisionClaim}) are permanent and single-use: they
 * record that a right was consumed, and they are never released. A lease is the opposite
 * — it is *held*, and therefore it must be renewable and it must **expire**, or the first
 * process to die with one takes the run to the grave. Both are arbitrated by the same
 * mechanism (an exclusive `wx` create the filesystem decides), because that is the only
 * primitive available that works across processes without a server.
 *
 * ### The fencing token
 *
 * `token` is a monotonically increasing integer, one per acquisition, and it is what
 * makes expiry safe. Expiry is a *guess* — a holder that stopped renewing may be dead, or
 * may be a live process that was paused for 31 seconds and is about to wake up and finish
 * writing. Without a fence, that process wakes into a run that has moved on without it
 * and clobbers it. With one, its write is refused: the run's current lease carries a
 * higher token, and a writer whose token is not the current one is not permitted to write
 * at all. This is the part that is usually got wrong (Kleppmann's "How to do distributed
 * locking" is the canonical statement of it), and it is why taking the lease over does
 * not require being *right* about the old holder being dead — only about it being stale.
 *
 * The token is the lease file's own name (`leases/000001.json`), so it is issued by the
 * same exclusive create that arbitrates the takeover: two processes that both see a stale
 * lease both try to create the next token, and the filesystem picks one.
 *
 * ### What it does NOT do
 *
 * Fencing stops a superseded segment from **writing**. It does not stop it from
 * **running** — a stale holder that is still alive may still be executing a tool, and
 * that tool's side effect has already happened by the time its write is refused. The
 * dispatch claim is what stops an *approved batch* from being dispatched twice; the lease
 * stops the *record* from being corrupted. Neither can un-charge a card. See the
 * durable-pause docs for the honest statement of what survives.
 */
export interface RunLease {
	runId: RunId
	/** Fencing token. Strictly increasing per run; the lease file's own name. */
	token: number
	/**
	 * Who holds it. Opaque, for diagnostics — `host:pid:uuid`. **Never authorization**: a
	 * holder is authorized by having won the exclusive create, not by presenting this.
	 */
	holderId: string
	acquiredAt: number
	/** Last heartbeat. `renewedAt + ttlMs` is when the lease goes stale. */
	renewedAt: number
	ttlMs: number
	/**
	 * Set when the holder handed the lease back cleanly — it parked, finished or failed.
	 * A released lease is free *immediately*; only a lease that was never released has to
	 * wait out its TTL. This is what makes a parked run resumable at once, and a crashed
	 * one resumable in `ttlMs`.
	 */
	releasedAt?: number
}

/**
 * The three states a run's lease can be in, and they are three, not two. The distinction
 * is the point:
 *
 *   - `free` — nobody is driving this run. Either it was never leased, or the last holder
 *     released it. **A parked run is this.** `awaiting_input` + `free` is the one
 *     combination that means "safe to resume".
 *   - `held` — a live segment is driving it and has renewed within its TTL. Not
 *     resumable; not parked, whatever `run.json` last managed to say.
 *   - `stale` — a holder took the lease and stopped renewing. It is *presumed* dead. The
 *     run may be taken over (which fences the old holder), but an operator looking at it
 *     must see "held by a segment that has not renewed since T", **not** "parked": those
 *     are different facts, and conflating them is how a crashed run gets reported as
 *     waiting for a human who was never asked.
 */
export type RunLeaseStatus = 'free' | 'held' | 'stale'

/** What an operator (or a resume) sees when it asks who owns a run. */
export interface RunLeaseView {
	status: RunLeaseStatus
	/** Highest fencing token ever issued for this run. `0` when it has never been leased. */
	token: number
	/** The lease record itself, when there is one. Absent only for a never-leased run. */
	lease?: RunLease
	/** When a `held` lease goes stale, or when a `stale` one did. Absent when `free`. */
	expiresAt?: number
}

/** Options for taking a run's lease. */
export interface RunLeaseOptions {
	/** Defaults to {@link DEFAULT_RUN_LEASE_TTL_MS}. */
	ttlMs?: number
	/** Defaults to {@link DEFAULT_RUN_LEASE_HEARTBEAT_MS}, floored at `ttlMs / 3`. */
	heartbeatMs?: number
	/** Diagnostics only. Defaults to `host:pid:uuid`. */
	holderId?: string
	/**
	 * How long the segment may sit unpulled at a `yield` before it hands the run back.
	 * Defaults to {@link DEFAULT_RUN_LEASE_ABANDON_MS}.
	 */
	abandonAfterMs?: number
}

/**
 * A live segment already holds this run's lease, so this one may not drive it.
 *
 * Carries `renewedAt` / `expiresAt` because "refused" is not enough for an operator: the
 * answer to "why can I not resume this run" is "because something else is driving it and
 * it was alive as recently as T", and the difference between T being two seconds ago and
 * two hours ago is the difference between waiting and investigating.
 */
export class RunLeaseHeldError extends Error {
	readonly runId: RunId
	readonly holderId: string
	readonly token: number
	readonly renewedAt: number
	readonly expiresAt: number

	constructor(lease: RunLease) {
		super(
			`Run ${lease.runId} is held by segment ${lease.holderId} (lease #${lease.token}, renewed ${new Date(lease.renewedAt).toISOString()}, stale after ${new Date(lease.renewedAt + lease.ttlMs).toISOString()}). A run is driven by one segment at a time.`,
		)
		this.name = 'RunLeaseHeldError'
		this.runId = lease.runId
		this.holderId = lease.holderId
		this.token = lease.token
		this.renewedAt = lease.renewedAt
		this.expiresAt = lease.renewedAt + lease.ttlMs
	}
}

/**
 * This writer's fencing token is stale: the run has been taken over, and the write is
 * refused rather than applied.
 *
 * The shape of the accident this prevents: a segment stalls (a 40-second GC pause, a
 * suspended container, a blocked syscall), its lease expires, another segment takes the
 * run over and drives it — and then the first one wakes up and finishes what it was
 * doing. Its `run.json` write would resurrect a run that has since completed; its
 * `messages.json` write would replace the new history with the old one. It is refused
 * here instead, on the token, which is a fact the filesystem arbitrates rather than a
 * fact the process believes about itself.
 */
export class RunLeaseLostError extends Error {
	readonly runId: RunId
	readonly heldToken: number
	readonly currentToken: number
	readonly operation: string

	constructor(runId: RunId, heldToken: number, currentToken: number, operation: string) {
		super(
			`Refusing ${operation} on run ${runId}: this segment holds lease #${heldToken} but the run is now on lease #${currentToken}. It was taken over — its record is not this segment's to write.`,
		)
		this.name = 'RunLeaseLostError'
		this.runId = runId
		this.heldToken = heldToken
		this.currentToken = currentToken
		this.operation = operation
	}
}

/**
 * This segment could not renew its lease for a whole TTL, so it no longer holds it.
 *
 * Distinct from a takeover: nobody has necessarily taken the run yet. The lease simply
 * **expired under us** — a run of consecutive renewal failures (a disk that would not take
 * the write, a `readdir` that kept failing) outlasted the window in which our claim to the
 * run was true. From the moment `renewedAt + ttlMs` passes, another segment is *entitled*
 * to take this run over, and a segment that kept driving after that would be driving a run
 * it does not own. It stops, and it stops QUIETLY — it is a {@link RunLeaseLostError}, so
 * every "this segment has no standing" path treats it identically to a real takeover.
 *
 * This is the other half of not aborting on the FIRST failed renewal: a transient `EMFILE`
 * on one heartbeat write means nothing, and treating it as a takeover durably failed
 * healthy, uncontended runs. Retrying is only safe because this bounds it.
 */
export class RunLeaseExpiredError extends RunLeaseLostError {
	readonly failures: number
	readonly lastRenewedAt: number

	constructor(runId: RunId, token: number, failures: number, lastRenewedAt: number, ttlMs: number) {
		super(runId, token, token, 'renew the lease')
		this.name = 'RunLeaseExpiredError'
		this.message = `Run ${runId}'s lease #${token} expired under this segment: ${failures} consecutive renewals failed and the TTL (${ttlMs}ms since ${new Date(lastRenewedAt).toISOString()}) has passed. Another segment may take the run over — this one no longer holds it.`
		this.failures = failures
		this.lastRenewedAt = lastRenewedAt
	}
}

/**
 * Nobody is consuming this run's events, so the segment gave the run back.
 *
 * `query()` returns an async generator, and a generator whose consumer drops it — without
 * a `break` and without a `.return()` — never runs its `finally`. The lease would be
 * renewed forever and the run would never be resumable again. The heartbeat notices
 * instead (see {@link DEFAULT_RUN_LEASE_ABANDON_MS}), releases the lease, and disowns the
 * store so that a consumer which *does* come back cannot resume writing to a run this
 * segment no longer owns.
 *
 * A {@link RunLeaseLostError}, because that is what it is: the segment does not hold this
 * run any more, and must not speak for it.
 */
export class RunSegmentAbandonedError extends RunLeaseLostError {
	readonly abandonedAfterMs: number

	constructor(runId: RunId, token: number, abandonedAfterMs: number) {
		super(runId, token, token, 'drive the run')
		this.name = 'RunSegmentAbandonedError'
		this.message = `Run ${runId} was abandoned by its consumer: nothing pulled an event from its generator for ${abandonedAfterMs}ms while it sat waiting to hand one over. The lease has been released so the run can be resumed; this segment is finished.`
		this.abandonedAfterMs = abandonedAfterMs
	}
}

/**
 * A run's lease file is on disk but cannot be read as a lease.
 *
 * **Fail-closed, and never a `SyntaxError`.** Whoever asks "who owns this run" — another
 * `acquireLease`, a redemption's lease check, an operator's `readRunLease`, the incumbent's
 * own fence — must get an answer they can reason about. An untyped `SyntaxError` out of
 * `JSON.parse` reached every one of those call sites as a 500 that a caller could not tell
 * from a server fault, and the honest answer is the opposite: we do not know who owns this
 * run, so nobody may assume they do.
 *
 * The lease's own create is atomic now (content and existence arrive in one step), so the
 * torn read this used to describe is gone at the source. This remains as the fail-closed
 * floor: a lease we cannot read is a lease we must not overwrite.
 */
export class RunLeaseUnreadableError extends Error {
	readonly runDir: string
	readonly token: number

	constructor(runDir: string, token: number, cause: unknown) {
		super(
			`Run lease #${token} in ${runDir} exists but could not be read as a lease (${cause instanceof Error ? cause.message : String(cause)}). Refusing to assume the run is free.`,
		)
		this.name = 'RunLeaseUnreadableError'
		this.runDir = runDir
		this.token = token
	}
}

/**
 * A run's write lock could not be taken, so the write was not attempted.
 *
 * The lock serialises a fenced write's [check the token → commit] against a takeover, which
 * is the only way to make those two steps one indivisible act on a filesystem that offers
 * no compare-and-set. A commit is two syscalls long, so waiting on this lock is a matter of
 * microseconds; failing to get it within the wait budget means something is badly wrong
 * (a wedged filesystem, a process suspended mid-commit), and the fail-closed answer is to
 * write nothing rather than to write unfenced.
 */
export class RunWriteLockTimeoutError extends Error {
	readonly runId: RunId
	readonly operation: string

	constructor(runId: RunId, operation: string, waitedMs: number) {
		super(
			`Could not take run ${runId}'s write lock within ${waitedMs}ms — refusing to ${operation} unfenced. Something else has been committing to this run for far longer than a commit takes.`,
		)
		this.name = 'RunWriteLockTimeoutError'
		this.runId = runId
		this.operation = operation
	}
}
