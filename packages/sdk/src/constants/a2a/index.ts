import type { WireRunStatus } from '../../contracts/index.js'
import type { A2ATaskState } from '../../types/a2a/index.js'

export const A2A_PROTOCOL_VERSION = '0.3.0'

/**
 * The exhaustive wire-status consumer. `Record<WireRunStatus, …>` is what makes
 * it exhaustive: a status added to {@link WireRunStatus} and not to this map is
 * a compile error, which is the only reason the suspension could not be added
 * to the wire and silently left unmapped here.
 *
 * `awaiting_input` → `input-required` is not an approximation. A2A has meant
 * "this task is blocked until someone answers it" by that state since 0.3.0,
 * and it is already what the event bridge emits for `tool_review_requested`,
 * `plan_ready` and `run_paused`. It is deliberately absent from
 * {@link TERMINAL_STATES}: a suspended task is still open.
 */
export const RUN_STATUS_TO_A2A: Record<WireRunStatus, A2ATaskState> = {
	queued: 'pending',
	running: 'running',
	awaiting_input: 'input-required',
	completed: 'completed',
	failed: 'failed',
	cancelled: 'canceled',
	cancelling: 'running',
	expired: 'failed',
}

export const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
	'completed',
	'failed',
	'canceled',
	'rejected',
])
