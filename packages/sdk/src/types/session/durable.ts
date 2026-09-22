/**
 * Durable turns: what an approval inbox, a crash sweep and `drainParkedTurns`
 * read about turns that outlived the process that ran them.
 *
 * The session log is the source of truth. A parked turn is a `turn_paused`
 * record followed by an open `decision_requested`; a claim is the session's
 * `lease.json`. The rows below are projections of those, served by
 * `SessionIndex.listTurns` and `SessionIndex.listPendingDecisions`.
 */

import type { HITLDecisionRequest } from '../hitl/index.js'
import type { CheckpointId, ProjectId, SessionId, TenantId, TurnId } from '../ids/index.js'

/**
 * A monotonically increasing number identifying one holding of a session's
 * lease.
 *
 * The load-bearing word is *fencing*. A mutex answers "may I proceed", and a
 * holder that stalls past its lease answers it "yes" and then writes, long
 * after somebody else legitimately took over. A fence answers a different
 * question at the moment of the WRITE: "is the holding I belong to still the
 * current one". Every claim mints a number strictly greater than the last,
 * and every session-log record carries the fence it was written under
 * (`gen`), so an append from a superseded holder is refused.
 *
 * Not a random token, deliberately: randomness proves identity and cannot
 * establish *order*, and order is the entire mechanism.
 */
export type FencingToken = number

/** A session's lease as a listing reports it. */
export interface LeaseSummary {
	readonly holder: string
	readonly fence: FencingToken
	readonly expiresAt: number
	/**
	 * Whether the lease had expired at the instant the listing was taken.
	 *
	 * A separate field rather than something the caller derives from
	 * `expiresAt`, because the caller would derive it against a DIFFERENT
	 * clock than the index used, and one page would then disagree with itself
	 * about which rows are available.
	 */
	readonly expired: boolean
}

/**
 * What a turn's human-in-the-loop park is doing, as far as the log can tell.
 *
 * A closed union rather than a boolean because the two unanswered states are
 * drained by DIFFERENT operators: `outstanding` is an approval inbox's queue
 * and `expired` is a reclamation sweep's.
 *
 * **Do not widen this union to say who is working on the turn.** A park is a
 * question put to a HUMAN; a lease is held by a PROCESS, and one turn can
 * have both, neither, or either. That is why {@link DurableTurnEntry.claim}
 * is a sibling field.
 */
export type ParkState =
	/** Decision requested, not resolved, deadline not passed. A human owes an answer. */
	| 'outstanding'
	/** Decision requested, not resolved, deadline passed (`decision_expired`). Nobody will answer it. */
	| 'expired'
	/** Decision resolved. Kept as evidence of who decided what. */
	| 'resolved'

/** A turn's park disposition, projected from its `decision_*` records. */
export interface ParkSummary {
	readonly state: ParkState
	/** The checkpoint the decision references. */
	readonly checkpointId: CheckpointId
	/** What the human was asked. Enough to route an inbox without a second read. */
	readonly requestType: HITLDecisionRequest['type']
	/** Epoch ms at which the turn parked. */
	readonly parkedAt: number
	/** Absolute expiry, when the decision carries one. */
	readonly deadlineAt?: number
	/** Epoch ms at which the answer arrived. Only on `resolved`. */
	readonly resolvedAt?: number
}

/**
 * One turn that has durable state: a row an approval inbox or a crash sweep
 * works from.
 *
 * It carries the full attribution, so `resumeSession({ scope: entry, … })`
 * and `claimSession(entry, …)` accept a row straight out of the listing.
 */
export interface DurableTurnEntry {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/** When the turn started (`turn_started.ts`), epoch ms. */
	readonly turnCreatedAt: number
	/** How many checkpoints the turn has right now. Pruning lowers it. */
	readonly checkpointCount: number
	/** Newest checkpoint — the one a resume restores by default. */
	readonly latestCheckpointId: CheckpointId
	/** Creation time of {@link DurableTurnEntry.latestCheckpointId}. */
	readonly latestCheckpointAt: number
	/** Absent when the turn has never parked. */
	readonly park?: ParkSummary
	/** Absent when no process holds or has held the session's lease. */
	readonly claim?: LeaseSummary
}

/**
 * Which order a listing comes back in.
 *
 *  - `'turnId'` — ascending by turn id. Stable and total; UUIDv7 ids sort by
 *    creation time, so this is also roughly chronological.
 *  - `'createdAt'` — oldest first by `turnCreatedAt`, then `turnId`: the
 *    triage order ("which turn has been waiting longest").
 */
export type DurableTurnOrder = 'turnId' | 'createdAt'

/** Filters and paging for a durable-turn listing. */
export interface ListDurableTurnsOptions {
	readonly tenantId: TenantId
	/** Narrow to one project. */
	readonly projectId?: ProjectId
	/** Narrow to one session. */
	readonly sessionId?: SessionId
	/** Defaults to `'turnId'`. A cursor is only meaningful within one order. */
	readonly orderBy?: DurableTurnOrder
	/**
	 * Keep only turns whose park is in one of these states. A turn that never
	 * parked is excluded by ANY value here; omit the filter to include it.
	 */
	readonly park?: readonly ParkState[]
	/**
	 * Keep only turns whose session is, or is not, currently leased. An
	 * expired lease counts as NOT held.
	 */
	readonly claimed?: boolean
	/** Page size. Defaults to 100, clamped to at least 1. */
	readonly limit?: number
	/** Resume token from the previous page's {@link DurableTurnPage.cursor}. */
	readonly cursor?: string
	/** Clock for expiry, so every entry in one page is judged against one instant. */
	readonly now?: number
}

/** One page of {@link DurableTurnEntry}. */
export interface DurableTurnPage {
	readonly entries: readonly DurableTurnEntry[]
	/** Pass to the next call. **Absent means the listing is exhausted.** */
	readonly cursor?: string
}
