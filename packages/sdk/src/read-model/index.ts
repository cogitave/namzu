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
export { RUN_STATUS_READ_MODEL_ID, createRunStatusReadModel } from './run-status.js'
export type { RunStatusReadModelOptions, RunStatusState } from './run-status.js'
