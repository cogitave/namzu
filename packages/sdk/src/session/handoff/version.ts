/**
 * Typed errors for the handoff state machine.
 *
 * See session-hierarchy.md §5.1 (illegal `active → locked` transition) and
 * §6.4 (concurrent CAS). Both classes carry structured `details` so consumers
 * can route without string parsing (Convention #5: deny-by-default, fail
 * fast).
 */

import type { RunId, SessionId } from '../../types/ids/index.js'

/**
 * Raised when a handoff's CAS write finds {@link Session.ownerVersion} has
 * advanced since the assignment was constructed — another actor committed
 * first (session-hierarchy.md §6.4 concurrent CAS). The caller re-reads and
 * decides whether to retry.
 */
export class HandoffVersionConflict extends Error {
	readonly details: {
		sessionId: SessionId
		expected: number
		actual: number
	}

	constructor(details: { sessionId: SessionId; expected: number; actual: number }) {
		super(
			`Handoff version conflict on ${details.sessionId}: expected ${details.expected}, actual ${details.actual}`,
		)
		this.name = 'HandoffVersionConflict'
		this.details = details
	}
}

/**
 * Reasons a session cannot transition `* → locked` for handoff. See
 * session-hierarchy.md §5.1 — lock entry requires an `idle` session with all
 * runs terminal. The three reasons are the non-terminal Run statuses that
 * fan in to a non-idle Session.
 */
export type HandoffLockRejectedReason = 'active_run' | 'pending_hitl' | 'pending_subsession'

/**
 * Raised when a handoff targets a session whose current Run is non-terminal.
 * Callers must wait for the active Run to terminalize (or cancel it) before
 * re-attempting the handoff (session-hierarchy.md §5.1).
 */
export class HandoffLockRejected extends Error {
	readonly details: {
		sessionId: SessionId
		reason: HandoffLockRejectedReason
		runId?: RunId
	}

	constructor(details: { sessionId: SessionId; reason: HandoffLockRejectedReason; runId?: RunId }) {
		super(`Handoff lock rejected on ${details.sessionId}: ${details.reason}`)
		this.name = 'HandoffLockRejected'
		this.details = details
	}
}
