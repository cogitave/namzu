import type { RunExecutionStatus } from '../types/common/index.js'
import type { PendingDecision } from '../types/hitl/index.js'
import { deriveRunStatus } from '../types/run/derive-status.js'
import type { RunStatus } from '../types/run/index.js'
import type { ReadModel } from './registry.js'

/**
 * A run's session-layer status, maintained from its own event log.
 *
 * `deriveRunStatus` answers about an instant: hand it a status and a park
 * and it projects them. Getting those two inputs meant holding the run
 * record and the park store, which a caller reading a finished run's
 * history — or a run in another process — does not have. This derives both
 * from the events the run already emits, so the projection needs the log
 * and nothing else.
 *
 * The instant-projector is still what answers; this only feeds it. Two
 * implementations of the same rule would be two chances to disagree about
 * what `awaiting_hitl_resolution` means, and the disagreement would show up
 * as a run that reads differently depending on which surface asked.
 */

export const RUN_STATUS_READ_MODEL_ID = 'namzu.run.status'

export interface RunStatusState {
	readonly execution: RunExecutionStatus
	/** The outstanding park, if the log says there is one. */
	readonly park?: PendingDecision
	/** `deriveRunStatus` at the moment the last event was folded in. */
	readonly status: RunStatus
}

/**
 * `now` is injected, and the reason is subtle enough to state.
 *
 * `awaiting_hitl` becomes `awaiting_hitl_resolution` when a deadline
 * passes, and a deadline passes without any event being emitted. So the
 * state a fold produces is the status AS OF the last event — which is the
 * honest thing for a projection to hold, since nothing woke it up at the
 * deadline. A caller that needs the answer right now re-projects with
 * `deriveRunStatus(state)` and its own clock; the field here is what the
 * log alone can say.
 */
export interface RunStatusReadModelOptions {
	readonly now?: () => number
}

export function createRunStatusReadModel(
	options: RunStatusReadModelOptions = {},
): ReadModel<RunStatusState> {
	const now = options.now ?? Date.now

	const project = (execution: RunExecutionStatus, park?: PendingDecision): RunStatusState => ({
		execution,
		...(park ? { park } : {}),
		status: deriveRunStatus({ status: execution, ...(park ? { park } : {}), now: now() }),
	})

	return {
		id: RUN_STATUS_READ_MODEL_ID,
		// `idle`, not `pending`. A run whose log is empty has not been queued
		// by anything this projection saw, and `queued` is a claim about a
		// decision somebody made.
		initial: () => project('idle'),

		apply(state, event) {
			switch (event.type) {
				case 'run_started':
					return project('running')
				case 'run_completed':
					return project('completed')
				case 'run_failed':
					return project('failed')

				case 'checkpoint_created':
				case 'run_paused':
					// A pause is not a park. The park below is what carries a
					// deadline and therefore what separates "waiting" from
					// "waited too long"; a pause with no park is a run that
					// stopped for a reason this projection cannot name, and
					// inventing `awaiting_hitl` for it would report a human as
					// owing an answer nobody asked them for.
					//
					// These two cases are BEHAVIOURALLY identical to the
					// `default` below and are kept anyway, which a mutation
					// correctly reports as surviving. They are here because
					// these are the two events a reader most expects to change
					// the status; falling into a silent `default` would leave
					// the next person to ask deducing the decision from its
					// absence, and the last time somebody deduced it they
					// deduced wrong.
					return state

				case 'tool_review_requested':
				case 'user_question_asked':
					// A park, as the log records one. `deadlineAt` is absent
					// here because these events do not carry it — so a run
					// waiting on a review reads `awaiting_hitl` and never
					// `awaiting_hitl_resolution`, which is correct: with no
					// deadline in the log there is nothing that could expire.
					return project(state.execution === 'idle' ? 'running' : state.execution, {
						// The shape `deriveRunStatus` actually reads: `resolvedAt`
						// absent means outstanding, and `deadlineAt` absent means
						// nothing can expire. `request` is carried because the
						// type requires it, and is the event itself — the log IS
						// what the run parked on, so synthesising a different
						// object would be inventing a request nobody made.
						request: event as unknown as PendingDecision['request'],
						parkedAt: event.timestamp,
					})

				case 'tool_review_completed':
				case 'user_question_answered':
				case 'run_resuming':
					// Answered. Dropping the park is what moves the run back to
					// `running`, and it has to happen on the ANSWER rather than
					// on the next tool call — a run that stayed `awaiting_hitl`
					// until it happened to do something else would show a human
					// as owed an answer they had already given.
					return project(state.execution)

				default:
					return state
			}
		},
	}
}
