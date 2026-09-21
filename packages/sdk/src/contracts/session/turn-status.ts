import type { TurnStatus } from '../../types/session/turn.js'

/**
 * A turn's status as HTTP, SSE and A2A payloads carry it.
 *
 * Distinct from the domain {@link TurnStatus}, which models the kernel's state
 * machine. The wire enum collapses domain members onto the shape a remote
 * client acts on: domain `succeeded` is wire `completed`, both `awaiting_hitl`
 * members are wire `awaiting_input`, and `awaiting_subsession` is wire
 * `running`.
 */
export type WireTurnStatus =
	| 'queued'
	| 'running'
	/**
	 * The turn is waiting on a human: an approval, a question or a review.
	 *
	 * Distinct from `running` because a client acts on it differently. A
	 * running turn settles by itself; a turn awaiting input settles only when
	 * someone answers, so a client that saw `running` would wait forever for
	 * an answer nobody is going to give. A2A carries it as `input-required`.
	 */
	| 'awaiting_input'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'cancelling'
	/**
	 * The turn's approval window closed with nobody answering.
	 *
	 * Set by a host sweeping expired parks. No domain status collapses onto
	 * it: the kernel is suspended while parked and never observes its own
	 * deadline passing.
	 */
	| 'expired'

/** Every {@link WireTurnStatus} member, in declaration order. */
export const WIRE_TURN_STATUSES = [
	'queued',
	'running',
	'awaiting_input',
	'completed',
	'failed',
	'cancelled',
	'cancelling',
	'expired',
] as const satisfies readonly WireTurnStatus[]

/**
 * The collapse of every domain {@link TurnStatus} onto the wire.
 *
 * A `Record` over the domain union, so a new domain status is a type error
 * here rather than an `undefined` on the wire.
 */
export const TURN_STATUS_TO_WIRE: Readonly<Record<TurnStatus, WireTurnStatus>> = Object.freeze({
	queued: 'queued',
	running: 'running',
	// Both HITL members wait on a person. `awaiting_hitl_resolution` is the
	// persisted variant (the user is absent and the turn survives until the
	// decision is resolved or the turn is abandoned); to a client the two are
	// the same thing: nothing happens until someone answers.
	awaiting_hitl: 'awaiting_input',
	awaiting_hitl_resolution: 'awaiting_input',
	// A turn delegated to a child session settles by itself when the child
	// does, so it is still running to a client.
	awaiting_subsession: 'running',
	succeeded: 'completed',
	failed: 'failed',
	cancelled: 'cancelled',
})

/**
 * Collapse a domain turn status onto the wire enum.
 *
 * Total over {@link TurnStatus}. A value outside the union (a status read from
 * an untyped source) throws rather than putting `undefined` on the wire.
 */
export function toWireTurnStatus(status: TurnStatus): WireTurnStatus {
	if (!Object.hasOwn(TURN_STATUS_TO_WIRE, status)) {
		throw new Error(`Unmapped turn status: ${String(status)}`)
	}
	return TURN_STATUS_TO_WIRE[status]
}
