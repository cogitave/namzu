import type { ArchiveBackendRef } from '../../types/retention/archive-backend-ref.js'
import type { DeliverableRef } from '../../types/summary/deliverable.js'
import type { SessionId } from '../ids/index.js'
import type { ActorRef } from './actor.js'
import type { SubSessionId, SummaryId, WorkspaceId } from './ids.js'

/**
 * Full 11-variant status union. See session-hierarchy.md §4.4 and the merge
 * state machine in §4.4.1. Absence of a `closed` state is load-bearing —
 * completed sub-sessions land on `idle` and stay there for drill-down
 * (Decision #5).
 */
export type SubSessionStatus =
	| 'pending'
	| 'active'
	| 'idle'
	| 'failed'
	| 'awaiting_merge'
	| 'pending_merge'
	| 'merging'
	| 'merged'
	| 'merge_conflict'
	| 'merge_rejected'
	| 'archived'

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
