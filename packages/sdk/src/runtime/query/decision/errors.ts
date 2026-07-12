import type { HITLResumeDecision, PendingDecisionState } from '../../../types/hitl/index.js'
import type { CheckpointId, DecisionRequestId, RunId } from '../../../types/ids/index.js'

/**
 * Errors raised while answering a paused decision.
 *
 * Each one exists because the decisions route has to answer a *different HTTP status*
 * for it (plan §D1): an exact duplicate of a recorded outcome is a 200 with that
 * outcome, a conflicting duplicate is a 409, an unknown or spent token is a 404/410,
 * and a run that can no longer be resumed is a 409. Collapsing them into one `Error`
 * would push the route into string-matching a message to decide what to say — which is
 * how "idempotent 200" ends up being returned for a typo'd token.
 */

/** No checkpoint, or no decision on it. Nothing to answer. */
export class DecisionNotFoundError extends Error {
	readonly runId: RunId
	readonly checkpointId: CheckpointId

	constructor(runId: RunId, checkpointId: CheckpointId) {
		super(`No pending decision found for run ${runId} at checkpoint ${checkpointId}`)
		this.name = 'DecisionNotFoundError'
		this.runId = runId
		this.checkpointId = checkpointId
	}
}

/**
 * The presented token is not this decision's token.
 *
 * Deliberately says nothing about *which* half was wrong, and is raised identically
 * whether the token is malformed, stale, or simply someone else's. The comparison
 * behind it is constant-time for the same reason: a caller must not be able to learn a
 * token by measuring how long a guess takes to be refused.
 */
export class DecisionTokenInvalidError extends Error {
	readonly runId: RunId
	readonly requestId: DecisionRequestId

	constructor(runId: RunId, requestId: DecisionRequestId) {
		super(`Invalid or spent resume token for decision ${requestId} on run ${runId}`)
		this.name = 'DecisionTokenInvalidError'
		this.runId = runId
		this.requestId = requestId
	}
}

/**
 * The decision was already answered. Carries the recorded outcome so the route can
 * distinguish an exact duplicate (answer 200 with it) from a conflicting one (409)
 * without a second round trip.
 */
export class DecisionAlreadyResolvedError extends Error {
	readonly runId: RunId
	readonly requestId: DecisionRequestId
	readonly state: PendingDecisionState
	readonly outcome?: HITLResumeDecision

	constructor(
		runId: RunId,
		requestId: DecisionRequestId,
		state: PendingDecisionState,
		outcome?: HITLResumeDecision,
	) {
		super(`Decision ${requestId} on run ${runId} is already ${state}`)
		this.name = 'DecisionAlreadyResolvedError'
		this.runId = runId
		this.requestId = requestId
		this.state = state
		this.outcome = outcome
	}
}

/**
 * The outcome does not answer the question that was asked.
 *
 * Refused at redemption rather than at application, because by application time it is
 * too late to say no: the token is already spent, so an outcome that cannot be applied
 * (answering an already-paused review with `pause`, say) would leave the run parked on
 * a decision nothing can ever answer again. A stranded run is the failure mode the
 * whole durable-pause programme exists to avoid.
 */
export class DecisionOutcomeInvalidError extends Error {
	readonly runId: RunId
	readonly requestId: DecisionRequestId
	readonly requestType: string
	readonly action: string

	constructor(runId: RunId, requestId: DecisionRequestId, requestType: string, action: string) {
		super(
			`Outcome '${action}' cannot answer a '${requestType}' decision (${requestId} on ${runId})`,
		)
		this.name = 'DecisionOutcomeInvalidError'
		this.runId = runId
		this.requestId = requestId
		this.requestType = requestType
		this.action = action
	}
}

/**
 * The run is not parked, so its decision may not be answered.
 *
 * This is P4's guarantee reaching through the durable-pause path: a cancelled run is
 * unresumable **by construction**, checked against the run's own persisted status
 * rather than against whether someone remembered to close its open decisions. A run
 * that is `cancelled`, `completed` or `failed` cannot be resumed no matter what token
 * is presented.
 */
export class RunNotResumableError extends Error {
	readonly runId: RunId
	readonly status: string

	constructor(runId: RunId, status: string) {
		super(`Run ${runId} is ${status} and cannot be resumed — only an awaiting_input run can`)
		this.name = 'RunNotResumableError'
		this.runId = runId
		this.status = status
	}
}

/**
 * An emergency dump taken while the run was awaiting a decision cannot be projected to
 * a checkpoint. Names the real checkpoint, which has the decision intact and IS
 * resumable. See {@link import('../checkpoint.js').projectEmergencyToCheckpoint}.
 */
export class EmergencyProjectionUnresumableError extends Error {
	readonly runId: RunId
	readonly checkpointId: CheckpointId
	readonly requestId: DecisionRequestId

	constructor(runId: RunId, checkpointId: CheckpointId, requestId: DecisionRequestId) {
		super(
			`Run ${runId} was awaiting decision ${requestId} when the emergency dump was taken. The dump does not carry the decision, so projecting it would repair away the tool call the decision is about. Resume from checkpoint ${checkpointId} instead — it has the decision.`,
		)
		this.name = 'EmergencyProjectionUnresumableError'
		this.runId = runId
		this.checkpointId = checkpointId
		this.requestId = requestId
	}
}
