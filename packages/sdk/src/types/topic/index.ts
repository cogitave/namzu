// Sub-barrel for the Topic type surface (Convention #4).
// Concrete types live in sibling files; re-export them here so consumers
// import via `../types/topic/index.js`.
//
// NZ-TOPIC-01: this barrel used to be `types/thread/index.ts`, exporting
// `ThreadStore`/`CreateThreadParams`/`Thread`/`ThreadStatus`. None of those
// four names was ever part of the SDK's public surface (verified against
// public-runtime.ts / public-types.ts, including their wildcard re-export
// chains), so they were free to rename outright with no deprecated alias.

export type { TopicStore, CreateTopicParams } from './store.js'
export type { Topic, TopicStatus } from './entity.js'

export { StaleObjectiveError } from './objective.js'
export type {
	ObjectiveAdvance,
	ObjectiveAdvanceResult,
	ObjectiveBlock,
	ObjectivePhase,
	ObjectiveRefusal,
	ObjectiveRoundVerdict,
	TopicObjective,
} from './objective.js'
