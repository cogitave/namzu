import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { RunStatus } from '../../types/run/status.js'
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

/**
 * Pure Run→Session fan-in helper per session-hierarchy.md §5.1.
 *
 * The precedence (highest first) matches the pattern-doc table:
 *   1. Session-level states that do not fan in from Run status:
 *      - `locked` (handoff CAS window) — preserved verbatim
 *      - `awaiting_merge` (broadcast source post-fan-out, §5.4) — preserved
 *      - `archived` (retention tombstone, §12.3) — preserved
 *   2. Any Run `running` or `awaiting_subsession` → Session `active`.
 *      (Phase 4 note: `awaiting_subsession` is not yet in {@link RunStatus};
 *      handled defensively as a future-proof guard — once the enum grows the
 *      exhaustiveness site here catches it automatically.)
 *   3. Any Run `awaiting_hitl` or `awaiting_hitl_resolution` → Session
 *      `awaiting_hitl`.
 *   4. All Runs `failed` and at least one Run present → Session `failed`.
 *   5. Otherwise (all runs terminal — succeeded/cancelled/failed mix, or no
 *      runs at all) → Session `idle`.
 *
 * `cancelled` does NOT surface a `failed` Session (§5.1 — "Cancellation is
 * not a terminal Session state"). Only `failed` runs drive the Session to
 * `failed` when every Run ended that way.
 */
export function deriveStatus(
	session: Session,
	runs: readonly { status: RunStatus }[],
): SessionStatus {
	// Session-level overrides — these states do not fan in from Run status.
	if (session.status === 'locked') return 'locked'
	if (session.status === 'awaiting_merge') return 'awaiting_merge'
	if (session.status === 'archived') return 'archived'

	// Any active Run → `active`.
	const hasActive = runs.some((r) => r.status === 'running')
	if (hasActive) return 'active'

	// Any HITL block (synchronous or persisted) → `awaiting_hitl`.
	const hasHitl = runs.some(
		(r) => r.status === 'awaiting_hitl' || r.status === 'awaiting_hitl_resolution',
	)
	if (hasHitl) return 'awaiting_hitl'

	// All failed (with at least one Run) → `failed`. Note that a `cancelled`
	// Run does NOT drive the Session to `failed`; §5.1 is explicit that
	// cancellation leaves the Session `idle`.
	if (runs.length > 0 && runs.every((r) => r.status === 'failed')) {
		return 'failed'
	}

	// Otherwise — empty run set, or all runs terminated (succeeded / cancelled
	// / mixed with failed) — the Session is `idle`.
	return 'idle'
}
