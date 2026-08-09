/**
 * CheckpointStore — persistence contract for iteration checkpoints.
 *
 * Mirrors the {@link import('../session/store.js').SessionStore} precedent:
 * a narrow interface the kernel consumes, with the built-in disk layout as
 * the default implementation and host-injected backends (e.g. Postgres) as
 * drop-in replacements. Every accessor takes an explicit
 * {@link CheckpointRunScope} so a shared backend can key rows by the full
 * five-layer attribution (Convention #17) instead of a filesystem path.
 */

import type { CheckpointId, HITLDecisionRequest, IterationCheckpoint } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'

/**
 * Identifies the run whose checkpoints are being addressed.
 *
 * The full Tenant → Project → Session → Run scope is required so shared
 * backends can enforce isolation; the built-in
 * {@link import('../../store/run/checkpoint-disk.js').DiskCheckpointStore}
 * is path-addressed (its `baseDir` already encodes project/session) and
 * only consults `runId`/`parentRunId` for directory layout.
 */
export interface CheckpointRunScope {
	/** Isolation boundary (Convention #17). */
	tenantId: TenantId
	/** Long-lived goal scope the run belongs to. */
	projectId: ProjectId
	/** Session the run is attributed to. */
	sessionId: SessionId
	/** Run whose checkpoints are addressed. */
	runId: RunId
	/**
	 * Present for sub-runs. Hierarchical stores may use it for layout (the
	 * disk store nests sub-run directories under
	 * `<parentRunId>/children/<runId>`); flat stores can ignore it.
	 */
	parentRunId?: RunId
}

/**
 * A CONTIGUOUS PREFIX of the run attribution hierarchy, addressing a SET of
 * runs rather than one.
 *
 * A separate type from {@link CheckpointRunScope} on purpose. That type
 * addresses exactly one run and four accessors depend on it doing so; making
 * its one distinguishing field optional in place would turn "the scope of a
 * run" into "some identifiers, maybe", and every accessor's guarantee with
 * it.
 *
 * Three properties, each deliberate:
 *
 *  - **`tenantId` is required.** Isolation is the one boundary that is never
 *    optional here. An untenanted listing is a cross-tenant read with a
 *    friendly name.
 *  - **It stops ABOVE the run.** No `runId`, no `parentRunId`. A caller
 *    holding a run id already has a full {@link CheckpointRunScope} and four
 *    accessors that take it; admitting one here would make
 *    `CheckpointRunScope` structurally assignable to this type and re-merge
 *    the two ideas the split exists to keep apart.
 *  - **The prefix must be contiguous.** A `sessionId` with no `projectId` is
 *    REFUSED, not silently widened to "that session under whichever project
 *    holds it". A flat backend can answer it and a hierarchical one cannot,
 *    so the answer would depend on the backend's storage shape — which is
 *    the one thing a store contract exists to hide.
 */
export interface CheckpointListingScope {
	/** Isolation boundary (Convention #17). Never optional. */
	readonly tenantId: TenantId
	/** Narrow to one project. Absent = every project of the tenant. */
	readonly projectId?: ProjectId
	/** Narrow to one session. Requires `projectId`. */
	readonly sessionId?: SessionId
}

/**
 * What a run's human-in-the-loop park is doing, as far as durable state can
 * tell.
 *
 * A closed union rather than a boolean because the two unanswered states are
 * drained by DIFFERENT operators: `outstanding` is an approval inbox's queue
 * and `expired` is a reclamation sweep's, and serving one to the other either
 * re-presents a dead approval forever or discards a live one.
 */
export type ParkState =
	/** `pending` set, no `resolvedAt`, deadline not passed. A human owes an answer. */
	| 'outstanding'
	/** `pending` set, no `resolvedAt`, deadline passed. Nobody will answer it. */
	| 'expired'
	/** `pending` set with `resolvedAt`. Kept as evidence of who decided what. */
	| 'resolved'

/** A run's park disposition, projected from the checkpoint that carries it. */
export interface ParkSummary {
	readonly state: ParkState
	/** The parked checkpoint — address it directly with `readCheckpoint`. */
	readonly checkpointId: CheckpointId
	/** What the human was asked. Enough to route an inbox without a second read. */
	readonly requestType: HITLDecisionRequest['type']
	/** Epoch ms at which the run parked. */
	readonly parkedAt: number
	/** Absolute expiry, when the park carries one. */
	readonly deadlineAt?: number
	/** Epoch ms at which the answer arrived. Only on `resolved`. */
	readonly resolvedAt?: number
}

/**
 * One run that has durable checkpoint state under the queried scope.
 *
 * **Extends {@link CheckpointRunScope}, and that is the load-bearing part.**
 * A listing whose rows cannot be turned back into an addressable scope is a
 * report, not a work queue. Because an entry IS a run scope,
 * `findPendingCheckpoint(store, entry)`, `new CheckpointManager(store, entry)`
 * and `resumeRun({ scope: entry, … })` all accept a row straight out of the
 * listing — with no re-assembly, and so no chance of assembling it wrong.
 *
 * ### What an entry deliberately does NOT carry
 *
 * A run STATUS. A checkpoint is written mid-flight, so nothing in this store
 * distinguishes a run that finished from one that died — the same fact
 * {@link import('../../runtime/query/run-state.js').loadRunState} already
 * states, where a rebuilt snapshot always reports `running` and the host's
 * own record stays the authority. A `status` field here would answer
 * "mid-flight" for every run that ever succeeded, and a sweeper built on it
 * would resume finished work.
 *
 * A crash sweep is therefore: list every run with durable state under the
 * scope, intersect with the host's own run records, resume the difference.
 */
export interface DurableRunEntry extends CheckpointRunScope {
	/** How many checkpoints the run has right now. Pruning lowers it. */
	readonly checkpointCount: number
	/** Newest checkpoint by `createdAt` — the one a resume restores by default. */
	readonly latestCheckpointId: CheckpointId
	/** `createdAt` of {@link DurableRunEntry.latestCheckpointId}. */
	readonly latestCheckpointAt: number
	/** Absent when the run has never parked. */
	readonly park?: ParkSummary
}

/** Filters and paging for {@link CheckpointStore.listDurableRuns}. */
export interface ListDurableRunsOptions {
	/**
	 * Keep only runs whose park is in one of these states. A run that never
	 * parked has no state and is excluded by ANY value here; omit the filter
	 * to include it.
	 */
	readonly park?: readonly ParkState[]
	/** Page size. Defaults to 100, clamped to at least 1. */
	readonly limit?: number
	/** Resume token from the previous page's {@link DurableRunPage.cursor}. */
	readonly cursor?: string
	/**
	 * Clock for expiry, so a sweep can be tested and so every entry in one
	 * page is judged against the same instant. Defaults to `Date.now()` — the
	 * same seam `findPendingCheckpoint` already takes.
	 */
	readonly now?: number
}

/** One page of {@link DurableRunEntry}. */
export interface DurableRunPage {
	readonly entries: readonly DurableRunEntry[]
	/**
	 * Pass to the next call. **Absent means the listing is exhausted**, so
	 * `while (cursor)` terminates; a store never returns a cursor it already
	 * knows yields nothing.
	 */
	readonly cursor?: string
}

/**
 * Persistence contract consumed by
 * {@link import('../../runtime/query/checkpoint.js').CheckpointManager} and
 * the replay entry points (`listCheckpoints` / `prepareReplayState`).
 *
 * Read accessors return `null` / an empty array when nothing exists for the
 * supplied scope — callers branch on missing explicitly, never on a thrown
 * not-found error. `deleteCheckpoint` is idempotent: deleting an absent
 * checkpoint succeeds as a no-op (mirrors the disk store's ENOENT
 * swallowing).
 *
 * ## Optional capabilities, and the rule that comes with them
 *
 * {@link CheckpointStore.listDurableRuns} is optional, following
 * `SessionStore.listSessionsByProject`. A required method would break every
 * host that has already implemented this interface, which is a `major` for
 * what is otherwise an additive capability.
 *
 * The rule optionality obliges: **a caller of an optional capability REFUSES
 * when it is absent; it never degrades.** An approval inbox built on a store
 * that cannot list has to throw, because an empty page would say "nothing is
 * waiting on a human" when the truth is "I cannot tell" — an optional
 * dependency degrading a check, which this repository has been bitten by
 * before. Reach the capability through
 * {@link import('../../store/run/listing.js').listDurableRuns}, which
 * refuses on absence rather than answering.
 *
 * Any capability added here later takes the same shape — optional method,
 * refusing helper. A cross-process claim is the next one, and a two-worker
 * deployment against a store with no lease has to fail loudly rather than
 * proceed.
 */
export interface CheckpointStore {
	/** Persist one checkpoint. Overwrites an existing checkpoint with the same id. */
	writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void>

	/** Load a single checkpoint by id. Returns `null` when it does not exist. */
	readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null>

	/**
	 * All checkpoints for the run, sorted by `createdAt` ascending (the
	 * ordering the disk store guarantees and `CheckpointManager.prune`
	 * relies on for oldest-first deletion).
	 */
	listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]>

	/** Delete a checkpoint by id. Absent checkpoints succeed as a no-op. */
	deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void>

	/**
	 * Every run with durable checkpoint state under a scope ABOVE the run.
	 * OPTIONAL — see the optional-capability rule on this interface.
	 *
	 * This is the read an approval inbox and a park sweep are built from, and
	 * the one thing this contract had no way to express: every other accessor
	 * needs a `runId`, so a host could only ask about runs it already knew
	 * about. `hitlParkTtlMs` documents a host sweep as the reclamation path
	 * for an unanswered park, and until this existed the sweep had no way to
	 * enumerate what to sweep.
	 *
	 * ### Ordering, and why it is not chronological
	 *
	 * Rows come back ordered by `runId` ascending, and the cursor is a
	 * position in that order.
	 *
	 * A cursor has to sort on a key that cannot move, or a paging caller
	 * skips rows and repeats rows. Every time-valued key this store can
	 * derive per run DOES move: the newest checkpoint's timestamp advances
	 * whenever the run checkpoints again, and the oldest one's advances
	 * whenever `CheckpointManager.prune` deletes oldest-first, which is what
	 * pruning does. `runId` is the only immutable, unique per-run key
	 * available, and being unique it is already a total order — the
	 * degenerate case of the rule `orderChildren` follows (sort on a key that
	 * cannot move, make the order total with an id), not a departure from it.
	 *
	 * The cost is that page order is arbitrary rather than oldest-first,
	 * because run ids carry no timestamp. Entries carry `latestCheckpointAt`
	 * and `park.parkedAt` so a caller can sort what it has read.
	 *
	 * A run whose FIRST checkpoint is written after paging began may be
	 * missed by that pass — it lands at whatever `runId` it minted, possibly
	 * behind the cursor. That is the right trade for a queue: the sweep runs
	 * again and picks it up next pass, whereas a moving sort key loses runs
	 * that already existed.
	 *
	 * @param scope contiguous prefix; `tenantId` required. Implementations
	 *   reject a hole (`sessionId` with no `projectId`) rather than guessing.
	 * @param options filters and paging. See {@link ListDurableRunsOptions}.
	 */
	listDurableRuns?(
		scope: CheckpointListingScope,
		options?: ListDurableRunsOptions,
	): Promise<DurableRunPage>
}
