// Sub-barrel for the handoff state machine (Convention #4).
// Concrete flow functions + types live in sibling files; re-export the public
// surface here. See session-hierarchy.md §6.

export type { HandoffAssignment, HandoffMode, HandoffOutcome } from './assignment.js'

export {
	DefaultCapacityValidator,
	DelegationCapacityExceeded,
} from './capacity.js'
export type { CapacityDimension, CapacityValidator } from './capacity.js'

export { HandoffLockRejected, HandoffVersionConflict } from './version.js'
export type { HandoffLockRejectedReason } from './version.js'

export { NOOP_HANDOFF_SINK } from './events.js'
export type {
	HandoffBroadcastRollbackEvent,
	HandoffCommittedEvent,
	HandoffEventSink,
	HandoffLockedEvent,
	HandoffUnlockedEvent,
} from './events.js'

export { executeSingleHandoff, NOOP_RUN_STATUS_RESOLVER } from './single.js'
export type { RunStatusResolver, SingleHandoffDeps } from './single.js'

export { executeBroadcastHandoff } from './broadcast.js'
export type { BroadcastHandoffDeps } from './broadcast.js'
