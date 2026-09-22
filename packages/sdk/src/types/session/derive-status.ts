import type { PendingDecision } from '../hitl/index.js'
import type { TurnExecutionStatus, TurnStatus } from './turn.js'

/**
 * Project what the SDK records about a turn onto the session-layer
 * {@link TurnStatus}.
 *
 * `Turn.status` is a {@link TurnExecutionStatus} — six values, none of which can
 * say "a human owes this turn an answer". `TurnStatus` has the vocabulary for
 * that and is consumed by session-status derivation and by handoff gating,
 * but nothing in the repo ever produced it: a host implementing a resolver
 * had to invent the projection, and the two `awaiting_hitl*` variants in
 * particular had no producer at all. `awaiting_hitl_resolution` documented
 * a "persisted wait after a HITL timeout" for a timeout nothing could
 * raise.
 *
 * The park record is the missing input. It is durable, it is what an
 * approval queue already reads, and it carries the deadline that separates
 * "waiting" from "waited too long".
 */
export function deriveTurnStatus(input: {
	/** What the turn itself recorded. */
	readonly status: TurnExecutionStatus
	/** The turn's outstanding park, if it has one. */
	readonly park?: PendingDecision
	/** Injectable for tests; defaults to now. */
	readonly now?: number
}): TurnStatus {
	const { status, park } = input
	const now = input.now ?? Date.now()

	// Terminal beats parked. A turn that finished, failed or was cancelled
	// is not waiting for anyone, whatever a stale park record says.
	switch (status) {
		case 'completed':
			return 'succeeded'
		case 'failed':
			return 'failed'
		case 'cancelled':
			return 'cancelled'
		case 'idle':
		case 'pending':
		case 'running':
			break
		default: {
			const _exhaustive: never = status
			throw new Error(`Unmapped agent status: ${_exhaustive as string}`)
		}
	}

	if (park && park.resolvedAt === undefined) {
		// A deadline that has passed means the window closed with nobody
		// answering. The work is not lost and the turn stays resumable from
		// its checkpoint, so this is a persisted wait rather than a terminal
		// state — which is exactly what the reserved variant describes.
		const expired = park.deadlineAt !== undefined && now >= park.deadlineAt
		return expired ? 'awaiting_hitl_resolution' : 'awaiting_hitl'
	}

	return status === 'running' ? 'running' : 'queued'
}
