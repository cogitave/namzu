import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { ProjectId, WorkspaceId } from '../../types/session/ids.js'
import type { ActorRef } from './actor.js'

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
 * Fields derived from session-hierarchy.md §4.3:
 *   - `previousActors` is append-only and publicly read-only; previous
 *     owners cannot write to the session again (Decision #3).
 *   - `ownerVersion` is the CAS counter for handoff (§6.1 / §6.2 / §6.4).
 *   - `workspaceId` is nullable for sessions whose workspace has not yet
 *     been provisioned (or has been torn down during archival).
 */
export interface Session {
	id: SessionId
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
