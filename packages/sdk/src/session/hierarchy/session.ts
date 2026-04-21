import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId, WorkspaceId } from '../../types/session/ids.js'
import type { ActorRef } from './actor.js'

// `deriveStatus` lives at `../status/derive.ts` (pure runtime helper, not a
// shape). Re-exported here so the existing `./index.ts:10` barrel line keeps
// working. See `docs.local/sessions/ses_010-sdk-type-layering/` commit 4.
export { deriveStatus } from '../status/derive.js'

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
 *   - `threadId` — the topic-level {@link Thread} this Session lives under.
 *     Set at creation, immutable; Sessions never move threads.
 *   - `projectId` — the {@link Project} the owning Thread belongs to.
 *     **Denormalized** from `thread.projectId` at creation time; immutable.
 *     Kept on the Session record for ergonomic access (Project-scoped
 *     consumers — handoff validators, archival, retention — would otherwise
 *     need a second round-trip to ThreadStore on every read). This is NOT
 *     a deprecated mirror of a fading field; it is a deliberate
 *     denormalization of structurally-immutable derived data.
 *
 * Other invariants (session-hierarchy.md §4.3):
 *   - `previousActors` is append-only and publicly read-only; previous
 *     owners cannot write to the session again.
 *   - `ownerVersion` is the CAS counter for handoff (§6.1 / §6.2 / §6.4).
 *   - `workspaceId` is nullable for sessions whose workspace has not yet
 *     been provisioned (or has been torn down during archival).
 */
export interface Session {
	id: SessionId
	threadId: ThreadId
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
