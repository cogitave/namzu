/**
 * Pure Turn→Session fan-in helper per session-hierarchy.md §5.1.
 *
 * Extracted from `session/hierarchy/session.ts` on 2026-04-21 (ses_010 commit
 * 4) so the shape definition can live under `types/session/` while the
 * runtime helper stays in a feature folder — the type-layering rule
 * (`types/` = pure shapes, feature folders = runtime).
 *
 * The precedence (highest first) matches the pattern-doc table:
 *   1. Session-level states that do not fan in from Turn status:
 *      - `locked` (handoff CAS window) — preserved verbatim
 *      - `awaiting_merge` (broadcast source post-fan-out, §5.4) — preserved
 *      - `archived` (retention tombstone, §12.3) — preserved
 *   2. Any turn `running` or `awaiting_subsession` → Session `active`.
 *      Delegation-in-flight is an active state of the parent — the parent
 *      turn is suspended waiting on the child's SessionSummaryMaterializer,
 *      and the session is NOT idle while that is pending.
 *   3. Any turn `awaiting_hitl` or `awaiting_hitl_resolution` → Session
 *      `awaiting_hitl`.
 *   4. All turns `failed` and at least one turn present → Session `failed`.
 *   5. Otherwise (all turns terminal — succeeded/cancelled/failed mix, or no
 *      turns at all) → Session `idle`.
 *
 * `cancelled` does NOT surface a `failed` Session (§5.1 — "Cancellation is
 * not a terminal Session state"). Only `failed` turns drive the Session to
 * `failed` when every Turn ended that way.
 */

import type { Session, SessionStatus } from '../../types/session/entity.js'
import type { TurnStatus } from '../../types/session/turn.js'

export function deriveStatus(
	session: Session,
	turns: readonly { status: TurnStatus }[],
): SessionStatus {
	// Session-level overrides — these states do not fan in from Turn status.
	if (session.status === 'locked') return 'locked'
	if (session.status === 'awaiting_merge') return 'awaiting_merge'
	if (session.status === 'archived') return 'archived'

	// Any active turn (in-flight iteration or awaiting a child sub-session) →
	// `active`. Delegation is an active state: the parent turn is suspended
	// waiting on the child's Materializer, not idle.
	const hasActive = turns.some((r) => r.status === 'running' || r.status === 'awaiting_subsession')
	if (hasActive) return 'active'

	// Any HITL block (synchronous or persisted) → `awaiting_hitl`.
	const hasHitl = turns.some(
		(r) => r.status === 'awaiting_hitl' || r.status === 'awaiting_hitl_resolution',
	)
	if (hasHitl) return 'awaiting_hitl'

	// All failed (with at least one turn) → `failed`. Note that a `cancelled`
	// turn does NOT drive the Session to `failed`; §5.1 is explicit that
	// cancellation leaves the Session `idle`.
	if (turns.length > 0 && turns.every((r) => r.status === 'failed')) {
		return 'failed'
	}

	// Otherwise — empty turn set, or all turns terminated (succeeded / cancelled
	// / mixed with failed) — the Session is `idle`.
	return 'idle'
}
