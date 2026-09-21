// Sub-barrel for the session-hierarchy event surface. Shape types live under
// `types/session/` (events.ts, records.ts); this barrel only re-exports them.
// No runtime emitter lives here.

export { SESSION_RECORD_SCHEMA_VERSION } from '../../types/session/records.js'
export type { SessionRecordSchemaVersion } from '../../types/session/records.js'

export type {
	ChildSessionSpawnedEvent,
	ChildSessionMessagedEvent,
	ChildSessionIdledEvent,
	ChildSessionLifecycleEvent,
} from '../../types/session/events.js'
