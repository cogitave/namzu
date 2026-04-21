// Compatibility shim — shape types moved to `types/summary/ref.ts`; runtime
// error classes moved to a sibling `./errors.ts`. Scheduled for deletion in
// ses_010 commit 8 once all direct-file consumers are rewritten.
// See `docs.local/sessions/ses_010-sdk-type-layering/`.

export { AGENT_SUMMARY_MAX_CHARS } from '../../types/summary/ref.js'
export type {
	SessionSummaryKeyDecision,
	SessionSummaryOutcome,
	SessionSummaryOutcomeStatus,
	SessionSummaryRef,
} from '../../types/summary/ref.js'
export { AgentSummaryTooLongError, SessionAlreadySummarizedError } from './errors.js'
