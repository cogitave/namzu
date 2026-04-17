/**
 * HandoffAssignment — the data envelope driving
 * {@link executeSingleHandoff} and {@link executeBroadcastHandoff}.
 *
 * See session-hierarchy.md §4.8 (HandoffAssignment), §6.1 (single-recipient
 * flow), §6.2 (multi-recipient broadcast flow). The shape exposed here is
 * intentionally minimal — a single row per (source, recipient) pair so the
 * broadcast flow can work with a homogeneous `readonly HandoffAssignment[]`.
 */

import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { HandoffId, ProjectId, WorkspaceId } from '../../types/session/ids.js'
import type { ActorRef } from '../hierarchy/actor.js'

/**
 * Handoff mode discriminator. `single` transfers ownership of the source
 * session; `broadcast` fans out into N isolated sub-sessions while the source
 * session parks at `awaiting_merge` (session-hierarchy.md §5.4 / §6.2).
 */
export type HandoffMode = 'single' | 'broadcast'

/**
 * Input row for a handoff execution. One record per source/recipient pair.
 *
 * For a `single` handoff, exactly one record is submitted. For a `broadcast`
 * handoff, N records share the same `sourceSessionId`, `broadcastId`, and
 * `expectedOwnerVersion`; recipients differ per row. See session-hierarchy.md
 * §4.8.
 */
export interface HandoffAssignment {
	id: HandoffId
	mode: HandoffMode
	sourceSessionId: SessionId
	tenantId: TenantId
	projectId: ProjectId
	/** The actor initiating the handoff (must be the source's current owner). */
	sourceActor: ActorRef
	/** Single recipient or one of many (for broadcast). */
	recipientActor: ActorRef
	/** CAS value for the source {@link Session.ownerVersion} at submission time. */
	expectedOwnerVersion: number
	createdAt: Date
	/** Correlates the N rows of a broadcast fan-out; required for `broadcast`. */
	broadcastId?: string
}

/**
 * Outcome of a committed handoff (single) or one row of a committed broadcast.
 *
 * `committedOwnerVersion` is the source session's version *after* commit. For
 * a broadcast, every row in the returned array reports the same committed
 * version (the source is CAS-locked once per broadcast, not per recipient).
 */
export interface HandoffOutcome {
	assignmentId: HandoffId
	/** The recipient's newly-spawned session id. */
	newSessionId: SessionId
	/** Isolated workspace provisioned for the recipient. */
	workspaceId: WorkspaceId
	/** Source session's new {@link Session.ownerVersion} after commit. */
	committedOwnerVersion: number
}
