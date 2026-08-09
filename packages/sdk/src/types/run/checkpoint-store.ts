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

/**
 * **Do not widen this union to say who is working on the run.**
 *
 * A consumer switches over `ParkState` exhaustively, so a fourth member is a
 * backward-incompatible change and a `major` — and the pull to add one is
 * real, because the next capability this contract takes is a cross-process
 * claim, and a queue worker draining the inbox wants to skip runs another
 * worker already holds.
 *
 * That is a different fact about a different subject. A park is a question
 * put to a HUMAN; a claim is a lease held by a PROCESS, and one run can have
 * both, neither, or either. Encoding them in one union makes the pair
 * unsayable and loses the state a worker needs most: parked AND unclaimed.
 *
 * The additive shape is a sibling optional field — `claim?: …` on
 * {@link DurableRunEntry}, `claimed?: …` on {@link ListDurableRunsOptions}.
 * A consumer reading rows is not broken by a new optional field, so the
 * claim ships as a second `minor` on this contract rather than a second
 * migration of it. This note exists because the union is the obvious place
 * to reach for and the wrong one.
 */

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
	/**
	 * When the run was attributed. Absent when it was never recorded.
	 *
	 * The only per-run key this store holds that does not move, which is why
	 * it is the one an oldest-first listing can page over — see
	 * {@link CheckpointStore.listDurableRuns} and
	 * `IterationCheckpoint.runCreatedAt`.
	 *
	 * **Absent means "not recorded", and a caller should render it that way
	 * rather than as a date it invents.** Every run checkpointed by a build
	 * carrying the stamp has one; a run that has none was checkpointed
	 * before the stamp existed.
	 */
	readonly runCreatedAt?: number

	/** How many checkpoints the run has right now. Pruning lowers it. */
	readonly checkpointCount: number
	/** Newest checkpoint by `createdAt` — the one a resume restores by default. */
	readonly latestCheckpointId: CheckpointId
	/** `createdAt` of {@link DurableRunEntry.latestCheckpointId}. */
	readonly latestCheckpointAt: number
	/** Absent when the run has never parked. */
	readonly park?: ParkSummary

	/**
	 * Absent when no process has ever claimed the run.
	 *
	 * A SIBLING of {@link DurableRunEntry.park}, not a member of
	 * {@link ParkState} — see the note on that union. A park is a question put
	 * to a human; a claim is a lease held by a process. A run can have both,
	 * neither, or either, and the state a queue worker needs most is parked
	 * AND unclaimed, which one union cannot say.
	 */
	readonly claim?: ClaimSummary
}

/**
 * Which order a listing comes back in.
 *
 * Explicit rather than implied, because the two available orders answer
 * different questions and neither is right for both. "Show me every run
 * waiting on a human" wants stable paging; "show me the one that has been
 * waiting longest" wants chronology. A listing that silently picked one
 * would be the same ambiguity the scope type removed by splitting.
 */
export type DurableRunOrder =
	/**
	 * By `runId` ascending. Stable and total, and meaningless as chronology —
	 * run ids carry no timestamp. The default, because it is what shipped.
	 */
	| 'runId'
	/**
	 * Oldest first, by {@link DurableRunEntry.runCreatedAt} then `runId`.
	 * This is the triage order: it answers which run has been waiting
	 * longest. Safe to page over, because the stamp is recorded once at
	 * attribution and never rewritten.
	 *
	 * **Runs whose creation was never recorded come FIRST**, ordered among
	 * themselves by `runId`. That is not a guess dressed up as a date: the
	 * stamp is written by the checkpoint manager, so a run lacking it on
	 * every checkpoint was checkpointed by a build that predates the stamp,
	 * and therefore predates every run that has one. Their
	 * `runCreatedAt` is absent on the row, so a caller can render "unknown"
	 * instead of a date nobody recorded.
	 */
	| 'createdAt'

/**
 * A monotonically increasing number identifying one holding of a run's claim.
 *
 * The load-bearing word is *fencing*. A mutex answers "may I proceed", and a
 * holder that stalls past its lease — a long GC pause, a suspended container,
 * a partitioned network — answers it "yes" and then writes, long after
 * somebody else legitimately took over. A fence answers a different question
 * at the moment of the WRITE: "is the holding I belong to still the current
 * one". Every claim of a run mints a number strictly greater than the last,
 * so a store can reject a write from a superseded holder without knowing
 * anything about processes, clocks or liveness.
 *
 * Not a random token, deliberately: randomness proves identity and cannot
 * establish *order*, and order is the entire mechanism.
 */
export type ClaimFence = number

/** A holding of a run's claim, as issued to the process that took it. */
export interface RunClaim {
	/** Opaque caller-supplied identity — a worker id, a pod name. Evidence, not authority. */
	readonly holder: string
	/** See {@link ClaimFence}. Present it on every durable write. */
	readonly fence: ClaimFence
	/**
	 * Absolute epoch ms after which the claim may be taken by somebody else.
	 *
	 * Absolute rather than a duration for the same reason a park's deadline
	 * is: it has to survive the process that set it. A duration plus an
	 * in-process timer cannot — the holder is the thing that dies.
	 */
	readonly expiresAt: number
}

/** A run's claim as a listing reports it. */
export interface ClaimSummary {
	readonly holder: string
	readonly fence: ClaimFence
	readonly expiresAt: number
	/**
	 * Whether the claim had expired at the instant the listing was taken.
	 *
	 * A separate field rather than something the caller derives from
	 * `expiresAt`, because the caller would derive it against a DIFFERENT
	 * clock than the store used, and one page would then disagree with
	 * itself about which rows are available.
	 */
	readonly expired: boolean
}

/** What a caller asks for when taking a run. */
export interface ClaimRunOptions {
	/** Who is taking it. Recorded so an operator can see what holds a stuck run. */
	readonly holder: string
	/** How long the holding is good for, in ms. */
	readonly ttlMs: number
	/** Clock, for tests and so one operation judges every expiry against one instant. */
	readonly now?: number
}

/** Filters and paging for {@link CheckpointStore.listDurableRuns}. */
export interface ListDurableRunsOptions {
	/**
	 * Ordering, and therefore what the cursor is a position in. Defaults to
	 * `'runId'`. A cursor is only meaningful within one order — do not carry
	 * one across a change of `orderBy`.
	 */
	readonly orderBy?: DurableRunOrder

	/**
	 * Keep only runs whose park is in one of these states. A run that never
	 * parked has no state and is excluded by ANY value here; omit the filter
	 * to include it.
	 */
	readonly park?: readonly ParkState[]
	/**
	 * Keep only runs that are, or are not, currently held by a worker.
	 *
	 * `false` is the queue-reader's filter: give me the work nobody has. A
	 * claim that has expired counts as NOT held, because that is what expiry
	 * means and a reader that skipped expired claims would leave a dead
	 * worker's runs invisible forever — the exact failure the lease exists to
	 * prevent.
	 */
	readonly claimed?: boolean
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
	/**
	 * Persist one checkpoint. Overwrites an existing checkpoint with the same id.
	 *
	 * @param fence the {@link ClaimFence} of the holding this write belongs
	 *   to, when the run is claimed. A store that supports claims REFUSES a
	 *   write whose fence is below the run's current one — that refusal is
	 *   what makes a claim a lease rather than a suggestion, because a holder
	 *   stalled past its expiry believes it still holds and is wrong only at
	 *   the moment it writes.
	 *
	 *   Omit it and the write is unfenced, which is exactly today's behaviour
	 *   and correct for a single-writer deployment. A store MUST NOT start
	 *   refusing unfenced writes because some other write carried a fence:
	 *   that would make adding a claim to one worker break every worker that
	 *   has not adopted it yet.
	 */
	writeCheckpoint(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
		fence?: ClaimFence,
	): Promise<void>

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
	 * ### Ordering
	 *
	 * Two orders, named by `options.orderBy`, and the cursor is a position in
	 * whichever one was asked for. See {@link DurableRunOrder}.
	 *
	 * Both sort on a key that cannot MOVE, which is the property a cursor
	 * needs — sort on a moving key and a paging caller skips rows and repeats
	 * rows. That rules out every time a checkpoint store can derive on its
	 * own: the newest checkpoint's timestamp advances whenever the run
	 * checkpoints again, and the oldest one's advances whenever
	 * `CheckpointManager.prune` deletes oldest-first, which is what pruning
	 * does. It leaves `runId`, which is immutable and unique but carries no
	 * timestamp, and `runCreatedAt`, which is recorded once at attribution
	 * and denormalized onto every checkpoint so pruning cannot reach it.
	 *
	 * `'runId'` alone is already a total order. `'createdAt'` tiebreaks on
	 * `runId`, which is the rule `orderChildren` follows: sort on a key that
	 * cannot move, make the order total with an id.
	 *
	 * A run whose FIRST checkpoint is written after paging began may be
	 * missed by that pass, in either order — it lands wherever its key puts
	 * it, possibly behind the cursor. That is the right trade for a queue:
	 * the sweep runs again and picks it up next pass, whereas a moving sort
	 * key loses runs that already existed.
	 *
	 * @param scope contiguous prefix; `tenantId` required. Implementations
	 *   reject a hole (`sessionId` with no `projectId`) rather than guessing.
	 * @param options filters and paging. See {@link ListDurableRunsOptions}.
	 */
	listDurableRuns?(
		scope: CheckpointListingScope,
		options?: ListDurableRunsOptions,
	): Promise<DurableRunPage>

	/**
	 * Take exclusive working possession of a run, or report that somebody
	 * else has it. OPTIONAL — see the optional-capability rule on this
	 * interface.
	 *
	 * Returns the holding on success and `null` when the run is currently
	 * held by somebody else. `null` is not an error: "another worker got
	 * there first" is the ordinary outcome of a queue with more than one
	 * reader, and a thrown exception would make the normal case look like a
	 * fault.
	 *
	 * ### What it is for
	 *
	 * Putting parked runs on a queue and letting more than one worker drain
	 * it. Without this, two workers restore the same checkpoint, both execute
	 * the run's tools, and both write checkpoints under one run id — each
	 * write minting a fresh checkpoint id, so two divergent chains land in
	 * one list and the pending lookup returns whichever wrote last. Half the
	 * work vanishes and nothing reports an error.
	 *
	 * ### The lease, and why it expires
	 *
	 * A claim is a LEASE, not a lock. A lock held by a process that dies is
	 * held forever, and the runs behind it are unreachable by anything except
	 * a human with a shell. The expiry is what makes a dead holder's work
	 * recoverable without one.
	 *
	 * The expiry is also why a fence exists. A holder does not know it has
	 * expired — a long pause, a suspended container and a partition all look
	 * from the inside like time not passing — so it wakes and writes as
	 * though it still holds. Liveness cannot be checked from here. What CAN
	 * be checked, at the write, is whether the holding that write belongs to
	 * is still the current one, and that is a comparison of two numbers.
	 *
	 * ### Reclaiming
	 *
	 * Calling this on a run whose claim has expired SUCCEEDS and mints a
	 * fence strictly greater than the expired holding's. The previous holder
	 * is not notified — it cannot be, that is the premise — it simply stops
	 * being able to write.
	 *
	 * Calling it again as the CURRENT holder also succeeds and extends the
	 * lease, minting a new fence. Renewal and reclamation are the same
	 * operation from the store's side, which is why there is no separate
	 * `renew`: two code paths that must agree about who holds a run is one
	 * more than can be kept correct.
	 */
	claimRun?(scope: CheckpointRunScope, options: ClaimRunOptions): Promise<RunClaim | null>

	/**
	 * Give a claim up early. Idempotent: releasing a claim that already
	 * expired, was superseded, or never existed succeeds as a no-op.
	 *
	 * Presenting a stale fence releases NOTHING — a worker that stalled past
	 * its lease must not be able to hand away a run somebody else is now
	 * holding, and that is the same fencing comparison the write path makes.
	 *
	 * Optional to call, not optional to matter: a worker that finishes and
	 * releases returns the run to the queue immediately, where one that just
	 * exits leaves it stuck until the lease expires. That is a latency
	 * difference, never a correctness one, which is the property that lets a
	 * crashed worker be indistinguishable from a slow one.
	 */
	releaseRun?(scope: CheckpointRunScope, fence: ClaimFence): Promise<void>
}
