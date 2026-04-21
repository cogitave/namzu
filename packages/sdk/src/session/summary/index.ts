// Sub-barrel for the session summary module (Convention #4).
//
// See session-hierarchy.md §4.7 (SessionSummaryRef shape) and §8.1
// (kernel-only emission invariant). Shape types live under
// `types/summary/`; runtime (materializer + error classes) lives in
// sibling files under `session/summary/`.

export type {
	ArtifactBlobDeliverable,
	DeliverableKind,
	DeliverableRef,
	FileDeliverable,
	MessageDeliverable,
	SessionSummaryDeliverable,
} from '../../types/summary/deliverable.js'
export { AGENT_SUMMARY_MAX_CHARS } from '../../types/summary/ref.js'
export type {
	SessionSummaryKeyDecision,
	SessionSummaryOutcome,
	SessionSummaryOutcomeStatus,
	SessionSummaryRef,
} from '../../types/summary/ref.js'
export { AgentSummaryTooLongError, SessionAlreadySummarizedError } from './errors.js'
export { SessionSummaryMaterializer } from './materialize.js'
export type {
	MaterializeInput,
	SessionSummaryMaterializerDeps,
} from './materialize.js'
