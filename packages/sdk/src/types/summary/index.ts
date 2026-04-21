// Sub-barrel for the session-summary shape surface (Convention #4).
// Concrete types live in sibling files; re-export them here.

export type {
	ArtifactBlobDeliverable,
	DeliverableKind,
	DeliverableRef,
	FileDeliverable,
	MessageDeliverable,
	SessionSummaryDeliverable,
} from './deliverable.js'
export { AGENT_SUMMARY_MAX_CHARS } from './ref.js'
export type {
	SessionSummaryKeyDecision,
	SessionSummaryOutcome,
	SessionSummaryOutcomeStatus,
	SessionSummaryRef,
} from './ref.js'
