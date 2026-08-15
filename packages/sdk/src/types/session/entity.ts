import type { SessionId, TenantId } from '../ids/index.js'
import type { ActorRef } from './actor.js'
import type { ProjectId, TopicId, WorkspaceId } from './ids.js'

/**
 * Session lifecycle states. See session-hierarchy.md §4.3 and the state
 * machine in §5.1. `awaiting_merge` is a sub-state of idle used on the
 * broadcast source session (§5.4) between fan-out and all recipients
 * terminalizing.
 */
export type SessionStatus =
	| 'active'
	| 'idle'
	| 'locked'
	| 'awaiting_hitl'
	| 'awaiting_merge'
	| 'failed'
	| 'archived'

/**
 * Multi-turn work unit owned by exactly one {@link ActorRef} at a time.
 *
 * Scope identifiers:
 *   - `topicId` — the {@link import('../topic/entity.js').Topic} this
 *     Session lives under. Set at creation, immutable; Sessions never move
 *     topics. Spelled `threadId` before NZ-TOPIC-03 — see
 *     `session/migration/id-prefix.ts` for the UNRELATED `thd_` meaning
 *     that rename did not touch (D2, ses_020).
 *   - `projectId` — the {@link import('../project/entity.js').Project} the
 *     owning Topic belongs to. **Denormalized** from `topic.projectId` at
 *     creation time; immutable. Kept on the Session record for ergonomic
 *     access (Project-scoped consumers — handoff validators, archival,
 *     retention — would otherwise need a second round-trip to TopicStore
 *     on every read). This is NOT a deprecated mirror of a fading field;
 *     it is a deliberate denormalization of structurally-immutable derived
 *     data.
 *
 * Other invariants (session-hierarchy.md §4.3):
 *   - `previousActors` is append-only and publicly read-only; previous
 *     owners cannot write to the session again.
 *   - `ownerVersion` is the CAS counter for handoff (§6.1 / §6.2 / §6.4).
 *   - `workspaceId` is nullable for sessions whose workspace has not yet
 *     been provisioned (or has been torn down during archival).
 *
 * The pure `deriveStatus(session, runs)` fan-in helper lives at
 * `session/status/derive.ts` — it is runtime, not a shape, so it is not
 * colocated with this interface.
 */
export interface Session {
	id: SessionId
	topicId: TopicId
	projectId: ProjectId
	tenantId: TenantId
	status: SessionStatus
	currentActor: ActorRef | null
	previousActors: readonly ActorRef[]
	workspaceId: WorkspaceId | null
	ownerVersion: number
	createdAt: Date
	updatedAt: Date
}
