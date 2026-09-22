import type { WireTurnStatus } from '../../contracts/session/turn-status.js'
import type { A2ATaskState } from '../../types/a2a/index.js'

export const A2A_PROTOCOL_VERSION = '0.3.0'

/**
 * A turn's wire status as an A2A task state. An A2A task is one namzu turn.
 *
 * `awaiting_input` is `input-required`: the turn waits on a person, and a peer
 * that read `running` would wait forever for an answer nobody gives.
 */
export const TURN_STATUS_TO_A2A: Readonly<Record<WireTurnStatus, A2ATaskState>> = Object.freeze({
	queued: 'pending',
	running: 'running',
	awaiting_input: 'input-required',
	completed: 'completed',
	failed: 'failed',
	cancelled: 'canceled',
	cancelling: 'running',
	expired: 'failed',
})

export const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
	'completed',
	'failed',
	'canceled',
	'rejected',
])
