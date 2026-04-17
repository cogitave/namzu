// Sub-barrel for session-hierarchy run-event surface.
// Convention #4: concrete types live in sibling files; re-export them here.
//
// Phase 2 scope is limited to the sub-session lifecycle variants that are
// spliced into `RunEvent`. A dedicated `SessionHierarchyEvent` top-level
// union lands in a later phase (see session-hierarchy.md §10.2).

export { RUN_EVENT_SCHEMA_VERSION } from './schema-version.js'
export type { RunEventSchemaVersion } from './schema-version.js'

export type {
	SubsessionSpawnedEvent,
	SubsessionMessagedEvent,
	SubsessionIdledEvent,
	SubsessionLifecycleEvent,
} from './types.js'
