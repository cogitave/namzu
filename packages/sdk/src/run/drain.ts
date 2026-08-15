/**
 * One pass over a queue of durable runs: list what nobody holds, take it,
 * hand it to a worker, give it back.
 *
 * Every primitive this composes already shipped —
 * {@link import('../store/run/listing.js').listDurableRuns} enumerates runs
 * above a run id, `claimRun` arbitrates between processes, `releaseRun`
 * returns a run to the queue, and `resumeRun` carries a fence into every
 * durable write. Nothing composed them, so the two things the claim was
 * built for — an approval inbox and a crash sweeper — still required a host
 * to write the loop, and writing it correctly means getting the release
 * into a `finally` and the `null` claim out of the error path. Both are the
 * kind of thing a host gets wrong once, quietly.
 *
 * ## What this deliberately is NOT
 *
 * A supervisor, a daemon, or a scheduler. There is no timer here, no
 * process spawn, no retry backoff and no `while (true)`. `drainRuns` makes
 * ONE bounded pass and returns what happened; running it again is the
 * caller's decision, made wherever that caller already has a scheduler. A
 * per-platform supervisor is the same trade the deployment-adapter matrix
 * was rejected for: one seam beats N adapters.
 *
 * The unit of work is a callback, so this module never needs a provider, a
 * tool registry or a sandbox — the half of a run that cannot be serialized
 * stays with the caller, exactly as `resumeRun` already splits it.
 */

import { claimRun, listDurableRuns, releaseRun, summarizePark } from '../store/run/listing.js'
import type { NamzuErrorCode } from '../types/errors/index.js'
import { NamzuError } from '../types/errors/index.js'
import type { RunId } from '../types/ids/index.js'
import type {
	CheckpointListingScope,
	CheckpointStore,
	DurableRunEntry,
	ParkState,
	RunClaim,
} from '../types/run/checkpoint-store.js'

/** Runs handled per pass when the caller names no page size. */
export const DEFAULT_DRAIN_PAGE_SIZE = 100

/**
 * What a drainer does with one run it successfully took.
 *
 * Receives the claim, not just its fence, because the holder and expiry are
 * what a worker needs to decide whether it still has time to start — and
 * because a caller that only ever sees a number tends to forget the lease
 * can lapse under it.
 *
 * The intended body is a resume:
 *
 * ```ts
 * onRun: (entry, claim) =>
 *   resumeRun({
 *     ...yourQueryParams,
 *     scope: { ...entry, topicId },
 *     checkpointStore: store,
 *     claimFence: claim.fence,
 *   })
 * ```
 *
 * `claimFence` is the whole reason the claim is handed over: a write that
 * does not carry it is unfenced, so a worker stalled past its lease would
 * still be able to overwrite the record of whoever took the run over.
 *
 * A throw is recorded against that run and the pass continues. A drainer
 * that died on the first bad run would leave the rest of the queue
 * untouched, which is the failure a queue exists to spread out.
 */
export type DrainRun = (entry: DurableRunEntry, claim: RunClaim) => void | Promise<void>

export interface DrainRunsParams {
	/** Backend to list, claim and release against. Must support all three. */
	readonly store: CheckpointStore
	/** Contiguous prefix — `tenantId` required. See {@link CheckpointListingScope}. */
	readonly scope: CheckpointListingScope
	/**
	 * Who is taking the runs. Per-PROCESS, never per-deployment: `holder` is
	 * the only thing that distinguishes a renewal from a theft, so two
	 * drainers sharing a string take live claims from each other instantly.
	 */
	readonly holder: string
	/** Lease length in ms. Long enough that the slowest run finishes inside it. */
	readonly ttlMs: number
	/** The work. See {@link DrainRun}. */
	readonly onRun: DrainRun

	/**
	 * Keep only runs whose park is in one of these states.
	 *
	 * **Absent means every run with durable state, parked or not**, and that
	 * is not a placeholder default — it is what a crash sweep wants, because
	 * a run that died mid-flight never parked and would be invisible under
	 * any park filter. An approval inbox passes `['outstanding']`; a
	 * reclamation sweep passes `['expired']`.
	 */
	readonly park?: readonly ParkState[]

	/**
	 * Stop taking new runs. Work already in flight is NOT interrupted — this
	 * module owns no run and cannot cancel one; a caller that needs to abort
	 * the work itself passes the same signal into whatever `onRun` starts.
	 */
	readonly signal?: AbortSignal

	/**
	 * How many runs may be in flight at once. Defaults to 1.
	 *
	 * Bounded on purpose. The obvious implementation — claim everything, then
	 * `Promise.all` — holds N leases while doing one run's worth of work, so
	 * the runs at the back of the batch expire before they are started and
	 * are taken by somebody else mid-flight.
	 */
	readonly maxConcurrent?: number

	/** Listing page size. See {@link DEFAULT_DRAIN_PAGE_SIZE}. */
	readonly pageSize?: number

	/**
	 * Clock for expiry, so one pass judges every claim against one instant
	 * and a test does not have to wait out a lease.
	 */
	readonly now?: number
}

/** A run a pass could not finish, and why. */
export interface DrainFailure {
	readonly runId: RunId
	readonly error: string
}

/** What one pass did. */
export interface DrainRunsResult {
	/** Rows the listing returned, before any of them were contended for. */
	readonly listed: number
	/** Runs whose `onRun` returned. */
	readonly drained: readonly RunId[]
	/**
	 * Runs another worker held. Not failures: "somebody got there first" is
	 * the ordinary outcome of a queue with more than one reader.
	 */
	readonly skipped: readonly RunId[]
	/**
	 * Runs that stopped matching {@link DrainRunsParams.park} between the
	 * listing and the claim, and were given straight back.
	 *
	 * Separate from {@link DrainRunsResult.skipped} because the cause is
	 * different and so is what an operator should do about a lot of them: a
	 * skip means another drainer is holding runs right now, a stale entry
	 * means another drainer already FINISHED one. Empty on a pass with no
	 * park filter, which has nothing to re-check against.
	 */
	readonly stale: readonly RunId[]
	/** Runs whose `onRun` threw. */
	readonly failed: readonly DrainFailure[]
	/**
	 * Runs that finished but whose lease could not be handed back.
	 *
	 * Separate from {@link DrainRunsResult.failed} because it is a different
	 * fact with a different consequence: the work is done and the record is
	 * written; the run is merely unavailable to the next reader until the
	 * lease lapses. Reported rather than swallowed — a release that quietly
	 * did nothing is how a queue silently loses throughput.
	 */
	readonly unreleased: readonly DrainFailure[]
	/** Whether the pass stopped early because the signal aborted. */
	readonly stopped: boolean
}

function refuse(code: NamzuErrorCode, message: string, details: Record<string, unknown>): never {
	throw new NamzuError({ code, message, details })
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Refuse a store that cannot do the whole job, BEFORE anything is listed.
 *
 * Checked up front rather than at the first call that needs each method, so
 * that a store missing only `releaseRun` cannot resume half a queue and then
 * discover it has no way to give the runs back. The optional-capability rule
 * on `CheckpointStore` says a caller refuses rather than degrades; a drainer
 * that degraded would be the worst instance of it, because "claimed by
 * default" here means every worker proceeds on every run.
 */
function assertDrainable(store: CheckpointStore): void {
	const missing = (['listDurableRuns', 'claimRun', 'releaseRun'] as const).filter(
		(m) => typeof store[m] !== 'function',
	)
	if (missing.length === 0) return
	refuse(
		'capability_unavailable',
		`drainRuns: the injected checkpoint store does not implement ${missing.map((m) => `\`${m}\``).join(', ')}, so it cannot arbitrate a queue. Refusing before anything is claimed rather than draining what it can — a drainer that proceeded without a claim would let two workers restore one checkpoint, both execute its tools and both write under one run id. Supply a store that implements all three (the built-in disk and in-memory stores do), or run a single writer per run.`,
		{ missing },
	)
}

/**
 * Take every unclaimed run under a scope, one bounded pass, and give each
 * one back when its work returns.
 *
 * The shape is: list parked-and-unclaimed → claim → work → release in a
 * `finally`. The `finally` is the part a host writes wrong: a worker that
 * returns without releasing leaves the run stuck until the lease lapses,
 * and a worker that releases only on success leaves a FAILED run stuck for
 * the same duration — so a queue quietly loses its throughput to the runs
 * that need retrying most.
 *
 * `claimed: false` is not a parameter. A drainer never wants work somebody
 * else holds; that is what makes it a drainer rather than a listing. An
 * expired claim counts as unheld, which is what makes a dead worker's runs
 * recoverable at all.
 *
 * ## What "exactly once" does and does not mean here
 *
 * Two drainers never hold one run at the same time — that is the claim, and
 * it is absolute. **Exactly-once over a whole pass is a weaker promise, and
 * where it holds it comes from the FILTER, not from the claim.** A listing
 * is a snapshot; between paging a row and claiming it, another drainer can
 * finish that run and release it, and the claim then succeeds on work
 * already done. So a claimed row is re-read against
 * {@link DrainRunsParams.park} before any work starts, and one that no
 * longer matches is given straight back as {@link DrainRunsResult.stale}.
 * An inbox drain (`park: ['outstanding']`) whose work answers the park is
 * therefore exactly-once, because doing the work is what removes the run
 * from the queue.
 *
 * With NO park filter there is nothing to re-check, and two drainers can
 * both process one run. That is not an omission: a checkpoint store holds no
 * run STATUS by design — nothing in it distinguishes a run that finished
 * from one that died — so "already done" is a fact only the host's own run
 * records carry. A crash sweep intersects with those records inside
 * `onRun`, which is the shape {@link DurableRunEntry} already prescribes.
 *
 * @throws NamzuError `capability_unavailable` when the store cannot list,
 *   claim or release — before any run is touched.
 * @throws NamzuError `invalid_config` on a lease or concurrency that cannot
 *   mean what it says.
 */
export async function drainRuns(params: DrainRunsParams): Promise<DrainRunsResult> {
	const { store, scope, holder, ttlMs, onRun, park, signal, now } = params

	assertDrainable(store)

	if (holder.trim().length === 0) {
		refuse(
			'invalid_config',
			'drainRuns: `holder` is empty. It is the only thing that distinguishes a renewal from a theft, so two drainers sharing one string take live claims from each other instantly. Use something per-process — a worker id, a pod name plus a pid.',
			{ holder },
		)
	}
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		refuse(
			'invalid_config',
			`drainRuns: ttlMs must be a positive number of milliseconds, got ${String(ttlMs)}. A lease that expires immediately is a lease every worker can take at once, which is the condition a claim exists to prevent.`,
			{ ttlMs },
		)
	}
	const maxConcurrent = params.maxConcurrent ?? 1
	if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
		refuse(
			'invalid_config',
			`drainRuns: maxConcurrent must be a positive integer, got ${String(params.maxConcurrent)}. Zero would drain nothing while reporting a successful pass.`,
			{ maxConcurrent: params.maxConcurrent },
		)
	}
	const pageSize = params.pageSize ?? DEFAULT_DRAIN_PAGE_SIZE

	const drained: RunId[] = []
	const skipped: RunId[] = []
	const stale: RunId[] = []
	const failed: DrainFailure[] = []
	const unreleased: DrainFailure[] = []
	let listed = 0
	let stopped = false

	const giveBack = async (entry: DurableRunEntry, fence: number): Promise<void> => {
		try {
			await releaseRun(store, entry, fence)
		} catch (err) {
			// Never rethrown: on the work path this runs inside a `finally`
			// unwinding the caller's error, and replacing it would send the
			// operator to debug the disk instead of the run.
			unreleased.push({ runId: entry.runId, error: toMessage(err) })
		}
	}

	/**
	 * Is this row still the row the listing described?
	 *
	 * A listing is a SNAPSHOT, and a claim taken against a stale snapshot is
	 * a claim on work somebody already did. The window is real and small:
	 * drainer B pages the queue, drainer A takes a run, finishes it, answers
	 * its park and releases — and B's claim then succeeds on a run that is no
	 * longer outstanding. Mutual exclusion cannot close that; only re-reading
	 * after the claim can, which is why this is here and not in the store.
	 *
	 * Only the park is re-checked, because it is the only predicate this loop
	 * was given. **Two drainers with no park filter can both process one
	 * run**, and no amount of claiming prevents it: a checkpoint store holds
	 * no run STATUS by design — see the note on {@link DurableRunEntry} — so
	 * "already done" is a fact only the host's own run records carry. A crash
	 * sweep intersects with those records inside `onRun`.
	 */
	const stillMatches = async (entry: DurableRunEntry): Promise<boolean> => {
		if (!park) return true
		const fresh = summarizePark(await store.listCheckpoints(entry), now ?? Date.now())
		return fresh !== undefined && park.includes(fresh.state)
	}

	/**
	 * One run: take it, work it, give it back.
	 *
	 * **No cancellation check here, and its absence is deliberate.** One was
	 * written, and a mutation test found nothing could kill it: the batch
	 * below dispatches with `.map(handle)`, which calls every handler
	 * synchronously before any of them awaits, so a signal that aborts during
	 * a batch cannot be observed at the top of a handler that has already
	 * been entered — and a signal that aborts BETWEEN batches is caught by
	 * the check in the loop, which runs first. A branch nothing can reach is
	 * a declaration nothing drives, so it is gone rather than covered by a
	 * test that would have proved nothing
	 * (`docs/conventions/declared-but-undriven.md`).
	 */
	const handle = async (entry: DurableRunEntry): Promise<void> => {
		const claim = await claimRun(store, entry, {
			holder,
			ttlMs,
			...(now !== undefined ? { now } : {}),
		})
		// `null` is not an error. Another worker got there first, which is the
		// ordinary outcome of two readers on one queue.
		if (!claim) {
			skipped.push(entry.runId)
			return
		}
		// Checked with the claim in hand rather than before taking it: only
		// under the claim is the answer stable, because nobody else can change
		// it while this drainer holds the run.
		if (!(await stillMatches(entry))) {
			stale.push(entry.runId)
			await giveBack(entry, claim.fence)
			return
		}
		try {
			await onRun(entry, claim)
			drained.push(entry.runId)
		} catch (err) {
			failed.push({ runId: entry.runId, error: toMessage(err) })
		} finally {
			await giveBack(entry, claim.fence)
		}
	}

	let cursor: string | undefined
	do {
		if (signal?.aborted) {
			stopped = true
			break
		}
		const page = await listDurableRuns(store, scope, {
			// Not a parameter. See the note above.
			claimed: false,
			...(park ? { park } : {}),
			limit: pageSize,
			...(cursor !== undefined ? { cursor } : {}),
			...(now !== undefined ? { now } : {}),
		})
		listed += page.entries.length

		// Windowed rather than `Promise.all` over the page: the leases are taken
		// as the work starts, so a page bigger than the pass can finish inside
		// one TTL does not hand the tail of it to somebody else mid-flight.
		for (let i = 0; i < page.entries.length; i += maxConcurrent) {
			if (signal?.aborted) {
				stopped = true
				break
			}
			await Promise.all(page.entries.slice(i, i + maxConcurrent).map(handle))
		}

		// A drained run is released, so it is unclaimed again — but the cursor
		// is a position in a total order and has already passed it, so the pass
		// cannot see it twice and cannot fail to terminate.
		cursor = stopped ? undefined : page.cursor
	} while (cursor !== undefined)

	return { listed, drained, skipped, stale, failed, unreleased, stopped }
}
