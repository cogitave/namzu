/**
 * Pure Run→Session fan-in helper per session-hierarchy.md §5.1.
 *
 * Extracted from `session/hierarchy/session.ts` on 2026-04-21 (ses_010 commit
 * 4) so the shape definition can live under `types/session/` while the
 * runtime helper stays in a feature folder — the type-layering rule
 * (`types/` = pure shapes, feature folders = runtime).
 *
 * The precedence (highest first) matches the pattern-doc table:
 *   1. Session-level states that do not fan in from Run status:
 *      - `locked` (handoff CAS window) — preserved verbatim
 *      - `awaiting_merge` (broadcast source post-fan-out, §5.4) — preserved
 *      - `archived` (retention tombstone, §12.3) — preserved
 *   2. Any Run `running` or `awaiting_subsession` → Session `active`.
 *      Delegation-in-flight is an active state of the parent — the parent
 *      Run is suspended waiting on the child's SessionSummaryMaterializer,
 *      and the session is NOT idle while that is pending.
 *   3. Any Run `awaiting_input` → Session `awaiting_hitl`. (The Session enum
 *      keeps its own spelling; the Run enum collapsed `awaiting_hitl` +
 *      `awaiting_hitl_resolution` into the single `awaiting_input` suspension
 *      in ses_017 P2.)
 *   4. All Runs `failed` and at least one Run present → Session `failed`.
 *   5. Otherwise (all runs terminal — succeeded/cancelled/failed mix, or no
 *      runs at all) → Session `idle`.
 *
 * `cancelled` does NOT surface a `failed` Session (§5.1 — "Cancellation is
 * not a terminal Session state"). Only `failed` runs drive the Session to
 * `failed` when every Run ended that way.
 */

import type { RunStatus } from '../../types/run/status.js'
import type { Session, SessionStatus } from '../../types/session/entity.js'

export function deriveStatus(
	session: Session,
	runs: readonly { status: RunStatus }[],
): SessionStatus {
	// Session-level overrides — these states do not fan in from Run status.
	if (session.status === 'locked') return 'locked'
	if (session.status === 'awaiting_merge') return 'awaiting_merge'
	if (session.status === 'archived') return 'archived'

	// Any active Run (in-flight iteration or awaiting a child sub-session) →
	// `active`. Delegation is an active state: the parent Run is suspended
	// waiting on the child's Materializer, not idle.
	const hasActive = runs.some((r) => r.status === 'running' || r.status === 'awaiting_subsession')
	if (hasActive) return 'active'

	// Any Run parked awaiting an external decision → `awaiting_hitl`.
	const hasHitl = runs.some((r) => r.status === 'awaiting_input')
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
