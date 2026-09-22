// A derived value maintained one event at a time. The registry's refusals
// are what make "incremental" a property rather than a hope: a duplicate
// double-counts, and a gap produces a state that looks complete and
// describes a log the registry never saw.
export {
	DuplicateEventError,
	EventGapError,
	ReadModelCollisionError,
	ReadModelRegistry,
	UnknownReadModelError,
} from './registry.js'
export type { ReadModel } from './registry.js'
export { SESSION_STATUS_READ_MODEL_ID, createSessionStatusReadModel } from './session-status.js'
export type { SessionStatusReadModelOptions, SessionStatusState } from './session-status.js'
