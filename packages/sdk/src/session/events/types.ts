import type { MessageId, RunId, SessionId } from '../../types/ids/index.js'
import type { SubSessionId } from '../../types/session/ids.js'
import type { ActorRef } from '../hierarchy/actor.js'
import type { Lineage } from '../hierarchy/lineage.js'
import type { RunEventSchemaVersion } from './schema-version.js'

/**
 * Sub-session lifecycle events that splice into {@link RunEvent}.
 *
 * See session-hierarchy.md §10.4 (Parent-Child Linkage). These cover the
 * in-flight visibility gap that the terminal-only `SessionSummaryRef` does
 * not address. Every sub-session emission carries the full {@link Lineage}
 * chain — consumers can reconstruct the delegation tree without walking the
 * store (§10.4 invariant).
 *
 * Note: these events are spliced into the `RunEvent` union in
 * `types/run/events.ts` rather than kept as a separate top-level union.
 * A dedicated `SessionHierarchyEvent` top-level type lands in Phase 3+.
 */

/**
 * Emitted when the kernel creates a new sub-session. Precedes the child
 * session's `run_started`. See §10.4 / §10.5 example stream.
 */
export interface SubsessionSpawnedEvent {
	type: 'subsession_spawned'
	runId: RunId
	subSessionId: SubSessionId
	parentSessionId: SessionId
	spawnedBy: ActorRef
	lineage: Lineage
	schemaVersion: RunEventSchemaVersion
	at: Date
}

/**
 * Emitted each time the child session's Run appends a message. Gives parents
 * and platform consumers in-flight visibility without requiring a drill into
 * the child transcript. See §10.4.
 */
export interface SubsessionMessagedEvent {
	type: 'subsession_messaged'
	runId: RunId
	subSessionId: SubSessionId
	parentSessionId: SessionId
	messageId: MessageId
	lineage: Lineage
	schemaVersion: RunEventSchemaVersion
	at: Date
}

/**
 * Emitted when the child session transitions to `idle` (terminal persistent
 * state per §5.3 — sub-sessions never close). A separate
 * `sub_session.summarized` event carries the `SessionSummaryRef` (§8); this
 * event only reports the lifecycle transition.
 */
export interface SubsessionIdledEvent {
	type: 'subsession_idled'
	runId: RunId
	subSessionId: SubSessionId
	parentSessionId: SessionId
	lineage: Lineage
	schemaVersion: RunEventSchemaVersion
	at: Date
}

export type SubsessionLifecycleEvent =
	| SubsessionSpawnedEvent
	| SubsessionMessagedEvent
	| SubsessionIdledEvent
