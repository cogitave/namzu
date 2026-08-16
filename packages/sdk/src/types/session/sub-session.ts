import type { ArchiveBackendRef } from '../../types/retention/archive-backend-ref.js'
import type { DeliverableRef } from '../../types/summary/deliverable.js'
import type { SessionId } from '../ids/index.js'
import type { ActorRef } from './actor.js'
import type { SubSessionId, SummaryId, WorkspaceId } from './ids.js'

/**
 * The lifecycle of the DELEGATION — the edge from parent to child, not the
 * child.
 *
 * This is the distinction the eleven-variant union lost. A `SubSession`
 * record describes one parent's handoff to one child; the child is an
 * ordinary `Session` in `SessionStore` with its own `SessionStatus`. Both
 * unions carry `active`, `idle` and `archived`, and `SessionStatus`
 * additionally carries `awaiting_merge` — so "is this thing active" had two
 * answers and nothing said which record to ask.
 *
 * Ask this one about the delegation: has the parent handed off yet, is the
 * child working, did the handoff fail, has the edge been retired. Ask
 * `SessionStatus` about the child's own work.
 *
 * These five are every value the kernel produces. Absence of a `closed`
 * state is load-bearing: a completed sub-session lands on `idle` and stays
 * there so it can still be drilled into.
 */
export type SubSessionDelegationStatus = 'pending' | 'active' | 'idle' | 'failed' | 'archived'

/**
 * @deprecated Use {@link SubSessionDelegationStatus}. Removal is a later
 * major, and the six extra members go with it.
 *
 * The merge half of this union was declared and never driven. Grepping
 * `packages/sdk` and `packages/cli` for each of `awaiting_merge`,
 * `pending_merge`, `merging`, `merged`, `merge_conflict` and
 * `merge_rejected` AS A SUB-SESSION STATUS finds no writer at all — the
 * many hits on `awaiting_merge` are `SessionStatus`, which is the shadowing
 * this type's replacement exists to end. Two of them (`merged`,
 * `merge_rejected`) had a READER: they sat in `ARCHIVABLE_STATUSES`, a set
 * that could never match on them.
 *
 * The union stays this wide for one release so a host that persisted one of
 * these values still typechecks while it migrates.
 */
export type SubSessionStatus =
	| SubSessionDelegationStatus
	/** @deprecated no producer since ratification */
	| 'awaiting_merge'
	/** @deprecated no producer since ratification */
	| 'pending_merge'
	/** @deprecated no producer since ratification */
	| 'merging'
	/** @deprecated no producer since ratification */
	| 'merged'
	/** @deprecated no producer since ratification */
	| 'merge_conflict'
	/** @deprecated no producer since ratification */
	| 'merge_rejected'

/**
 * Discriminator for how a sub-session was created. Pattern doc §4.4
 * enumerates four variants; the three kept here collapse `user_handoff`
 * and `user_broadcast` into the single `user_handoff` kind (multi-recipient
 * flows are encoded via `broadcastGroupId` in later phases).
 */
export type SubSessionKind = 'agent_spawn' | 'user_handoff' | 'intervention'

/**
 * Per-spawn failure policy for parallel fan-out. See session-hierarchy.md
 * §4.4. Default is `delegate` — siblings continue and the parent agent
 * decides what to do with partial results.
 */
export type FailureMode = 'fail_fast' | 'delegate'

/**
 * Completion contract the parent expects. See session-hierarchy.md §9.
 *
 * `summary_ref` is the default for agent delegation and interventions.
 * `merge_back` is used by multi-user handoff; full spec lives in
 * `collaboration-primitives.md`.
 */
export type CompletionMode = 'summary_ref' | 'merge_back'

/**
 * Re-export of the real {@link DeliverableRef} discriminated union. The
 * concrete shape lives in `../summary/deliverable.ts` — see
 * session-hierarchy.md §4.7 / §8.1. Phase 5 replaced the Phase 1 `unknown`
 * placeholder with the real type.
 */
export type { DeliverableRef }

/**
 * Edge between a parent {@link import('./entity.js').Session} and a child
 * session, carrying the delegation metadata. The child session itself lives
 * in `SessionStore` like any other session — see session-hierarchy.md §4.4.
 */
export interface SubSession {
	id: SubSessionId
	parentSessionId: SessionId
	childSessionId: SessionId
	kind: SubSessionKind
	/**
	 * The DELEGATION's lifecycle, not the child's. The child session has its
	 * own {@link import('./entity.js').SessionStatus}; when the two disagree
	 * this one is authoritative about whether the parent still has a live
	 * handoff, and that one is authoritative about whether the child is
	 * working. Typed as the wide alias for one more release; every value the
	 * kernel writes is a {@link SubSessionDelegationStatus}.
	 */
	status: SubSessionStatus
	spawnedBy: ActorRef
	spawnedAt: Date
	failureMode: FailureMode
	completionMode: CompletionMode
	workspaceId: WorkspaceId | null
	/**
	 * For interventions, the immutable artifact being addressed. Chains form
	 * a strict acyclic DAG — see session-hierarchy.md §4.5.
	 */
	prevArtifactRef?: DeliverableRef
	/** Fan-out bookkeeping for broadcasts (§4.4). */
	broadcastGroupId?: string
	/** Populated by {@link SessionSummaryMaterializer} on terminalization (§8). */
	summaryRef?: SummaryId
	/**
	 * Pointer to the archive bundle for this sub-session. Present iff
	 * `status === 'archived'` (pattern doc §12.3). The paired
	 * {@link archivedAt} timestamp captures when the bundle was sealed.
	 * Cleared by {@link ArchivalManager.restore}.
	 */
	archiveRef?: ArchiveBackendRef
	archivedAt?: Date
	updatedAt: Date
}
