import type { HITLDecisionRequest, PendingDecision } from '../types/hitl/index.js'
import { deriveTurnStatus } from '../types/session/derive-status.js'
import type { TurnExecutionStatus, TurnStatus } from '../types/session/index.js'
import type { ReadModel } from './registry.js'

/**
 * A session's status, maintained from its own log.
 *
 * `deriveTurnStatus` answers about an instant: hand it a status and a park
 * and it projects them. This derives both from the session log's records —
 * the turn lifecycle and the `decision_*` records — so the projection needs
 * the log and nothing else, in this process or another.
 *
 * The instant-projector is still what answers; this only feeds it, so the
 * rule for `awaiting_hitl_resolution` has one implementation.
 */

export const SESSION_STATUS_READ_MODEL_ID = 'namzu.session.status'

export interface SessionStatusState {
	/** The execution status of the session's latest turn (`idle` before any). */
	readonly execution: TurnExecutionStatus
	/** The outstanding park, if the log says there is one. */
	readonly park?: PendingDecision
	/** `deriveTurnStatus` at the moment the last record was folded in. */
	readonly status: TurnStatus
}

/**
 * `now` is injected: `awaiting_hitl` becomes `awaiting_hitl_resolution` when
 * a deadline passes, and a deadline passes without any record being
 * appended. The state a fold holds is the status as of the last record; a
 * caller that needs the answer right now re-projects with its own clock.
 */
export interface SessionStatusReadModelOptions {
	readonly now?: () => number
}

export function createSessionStatusReadModel(
	options: SessionStatusReadModelOptions = {},
): ReadModel<SessionStatusState> {
	const now = options.now ?? Date.now

	const project = (execution: TurnExecutionStatus, park?: PendingDecision): SessionStatusState => ({
		execution,
		...(park ? { park } : {}),
		status: deriveTurnStatus({ status: execution, ...(park ? { park } : {}), now: now() }),
	})

	return {
		id: SESSION_STATUS_READ_MODEL_ID,
		// `idle`, not `pending`: a session whose log holds no turn has not been
		// queued by anything this projection saw.
		initial: () => project('idle'),

		apply(state, record) {
			switch (record.type) {
				case 'turn_started':
					return project('running')
				case 'turn_completed':
					return project(record.settlement.status)
				case 'turn_failed':
					return project('failed')
				case 'decision_requested':
					// A park, as the log records one, with its absolute deadline.
					return project(state.execution === 'idle' ? 'running' : state.execution, {
						request: record.request as unknown as HITLDecisionRequest,
						parkedAt: Date.parse(record.ts),
						...(record.deadlineAt !== undefined
							? { deadlineAt: Date.parse(record.deadlineAt) }
							: {}),
					})
				case 'decision_resolved':
				case 'decision_expired':
				case 'turn_resuming':
					// Answered (or ended): dropping the park moves the turn back to
					// `running` on the answer, not on the turn's next step.
					return project(state.execution)
				default:
					// A pause is not a park: `turn_paused` with no open decision is
					// a provider wait, and inventing `awaiting_hitl` for it would
					// report a human as owing an answer nobody asked them for.
					return state
			}
		},
	}
}
