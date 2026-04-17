// Sub-barrel for the session summary module (Convention #4).
//
// See session-hierarchy.md §4.7 (SessionSummaryRef shape) and §8.1
// (kernel-only emission invariant). Concrete types and the materializer live
// in sibling files; re-export them here so consumers import via
// `../session/summary/index.js`.

export type {
	ArtifactBlobDeliverable,
	DeliverableKind,
	DeliverableRef,
	FileDeliverable,
	MessageDeliverable,
	SessionSummaryDeliverable,
} from './deliverable.js'
export {
	AGENT_SUMMARY_MAX_CHARS,
	AgentSummaryTooLongError,
	SessionAlreadySummarizedError,
} from './ref.js'
export type {
	SessionSummaryKeyDecision,
	SessionSummaryOutcome,
	SessionSummaryOutcomeStatus,
	SessionSummaryRef,
} from './ref.js'
export { SessionSummaryMaterializer } from './materialize.js'
export type {
	MaterializeInput,
	SessionSummaryMaterializerDeps,
} from './materialize.js'
