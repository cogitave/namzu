// Sub-barrel for session-hierarchy run-event surface.
// Shape types live under `types/run/` (subsession-events.ts + schema-version.ts);
// this barrel only re-exports them. No runtime emitter lives here today.
//
// Phase 2 scope is limited to the sub-session lifecycle variants that are
// spliced into `RunEvent`. A dedicated `SessionHierarchyEvent` top-level
// union lands in a later phase (see session-hierarchy.md §10.2).

export { RUN_EVENT_SCHEMA_VERSION } from '../../types/run/schema-version.js'
export type { RunEventSchemaVersion } from '../../types/run/schema-version.js'

export type {
	SubsessionSpawnedEvent,
	SubsessionMessagedEvent,
	SubsessionIdledEvent,
	SubsessionLifecycleEvent,
} from '../../types/run/subsession-events.js'
