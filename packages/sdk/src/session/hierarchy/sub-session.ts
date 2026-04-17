import type { SessionId } from '../../types/ids/index.js'
import type { SubSessionId, SummaryId, WorkspaceId } from '../../types/session/ids.js'
import type { ActorRef } from './actor.js'

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
 * TODO(Phase 5): replace with the real `DeliverableRef` discriminated union
 * defined in `src/session/summary/deliverable.ts`. Kept as `unknown` here so
 * Phase 1 stays type-only — agents must not construct a ref from this type.
 */
export type DeliverableRef = unknown

/**
 * Edge between a parent {@link Session} and a child session, carrying the
 * delegation metadata. The child session itself lives in `SessionStore`
 * like any other session — see session-hierarchy.md §4.4.
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
	updatedAt: Date
}
