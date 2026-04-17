/**
 * HandoffEventSink — pluggable event sink for Phase 4.
 *
 * Phase 4 does NOT extend `RunEvent` with handoff variants (they land in a
 * later phase that wires the full `SessionHierarchyEvent` union referenced
 * by roadmap §1). In the meantime the flow functions invoke this sink so
 * consumers + tests can observe state transitions without a concrete event
 * bus. Every callback is optional; {@link NOOP_HANDOFF_SINK} is the
 * deny-by-default instance to pass when observation is not needed.
 */

import type { SessionId } from '../../types/ids/index.js'
import type { HandoffId } from '../../types/session/ids.js'

/** Fired when a source session transitions `idle → locked` for handoff. */
export interface HandoffLockedEvent {
	sessionId: SessionId
	at: Date
}

/**
 * Fired when a compensating rollback returns a source session
 * `locked → idle` (either CAS failure or downstream provisioning failure).
 */
export interface HandoffUnlockedEvent {
	sessionId: SessionId
	at: Date
}

/**
 * Fired once per handoff commit. For `single` the `handoffIds` array has one
 * entry; for `broadcast` it contains every recipient's assignment id.
 */
export interface HandoffCommittedEvent {
	sessionId: SessionId
	newVersion: number
	handoffIds: readonly HandoffId[]
	at: Date
}

/**
 * Fired when a broadcast fan-out mid-flight rolls back. `partialState` carries
 * the per-stage counts of resources that were provisioned before the failure
 * was detected — consumers can correlate with their own observability signals
 * to verify the rollback is complete.
 */
export interface HandoffBroadcastRollbackEvent {
	sessionId: SessionId
	broadcastId: string
	reason: string
	partialState: {
		assignmentsWritten: number
		subsessionsCreated: number
		worktreesProvisioned: number
	}
	at: Date
}

/**
 * Pluggable observer interface. All callbacks optional; consumers implement
 * only what they need (Convention #5 deny-by-default applies to event
 * consumers too — they must opt in explicitly).
 */
export interface HandoffEventSink {
	onLocked?(ev: HandoffLockedEvent): void
	onUnlocked?(ev: HandoffUnlockedEvent): void
	onCommitted?(ev: HandoffCommittedEvent): void
	onBroadcastRollback?(ev: HandoffBroadcastRollbackEvent): void
}

/** No-op sink — inject when the caller does not need handoff observability. */
export const NOOP_HANDOFF_SINK: HandoffEventSink = Object.freeze({})
