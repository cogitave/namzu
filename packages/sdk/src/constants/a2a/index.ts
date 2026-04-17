import type { WireRunStatus } from '../../contracts/index.js'
import type { A2ATaskState } from '../../types/a2a/index.js'

export const A2A_PROTOCOL_VERSION = '0.3.0'

export const RUN_STATUS_TO_A2A: Record<WireRunStatus, A2ATaskState> = {
	queued: 'pending',
	running: 'running',
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
