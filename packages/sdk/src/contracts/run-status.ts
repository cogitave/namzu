import type { RunStatus } from '../types/run/status.js'
import type { WireRunStatus } from './api.js'

/**
 * Collapse a domain run status onto the wire enum.
 *
 * The mapping was documented on `WireRunStatus` and implemented nowhere, so
 * every surface that needed it open-coded the collapse or, more often,
 * passed a domain status where a wire one was expected and relied on the
 * two enums happening to share spellings. They do not share all of them:
 * `succeeded` and `awaiting_*` have no wire counterpart at all.
 *
 * Total over the domain enum, and exhaustive by construction so a new
 * domain status is a type error here rather than an `undefined` on the
 * wire.
 */
export function toWireRunStatus(status: RunStatus): WireRunStatus {
	switch (status) {
		case 'queued':
			return 'queued'
		case 'running':
			return 'running'
		// A run waiting on a human is still a live run to a wire consumer:
		// it has not settled, and nothing it can do will make it settle.
		// `awaiting_hitl_resolution` is the persisted variant — the user is
		// absent and the run survives until answered or cancelled — which is
		// waiting, not finished.
		case 'awaiting_hitl':
		case 'awaiting_hitl_resolution':
		case 'awaiting_subsession':
			return 'running'
		case 'succeeded':
			return 'completed'
		case 'failed':
			return 'failed'
		case 'cancelled':
			return 'cancelled'
		default: {
			const _exhaustive: never = status
			throw new Error(`Unmapped run status: ${_exhaustive as string}`)
		}
	}
}
