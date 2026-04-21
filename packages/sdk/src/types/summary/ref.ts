/**
 * SessionSummaryRef — the structured pointer a parent session sees when a
 * sub-session completes. Kernel-owned terminalization primitive: the only
 * producer is `SessionSummaryMaterializer.materialize` (see
 * `session/summary/materialize.ts`). See session-hierarchy.md §4.7 (shape)
 * and §8.1 (emission invariant).
 *
 * The `materializedBy: 'kernel'` literal field is load-bearing — combined
 * with the opaque {@link SummaryId} brand (mintable only by
 * `generateSummaryId`), it enforces at the type level that no agent or tool
 * can construct a valid `SessionSummaryRef`. `SessionStore.recordSummary`
 * only accepts `SessionSummaryRef & { materializedBy: 'kernel' }`, so even a
 * payload shaped correctly would fail the structural check.
 *
 * This is Convention #0 load-bearing: there is no "tool" path to emit a
 * summary; the parent agent sees only what the kernel seals.
 *
 * Runtime errors related to summary emission (`AgentSummaryTooLongError`,
 * `SessionAlreadySummarizedError`) are runtime and therefore live at
 * `session/summary/errors.ts` — they are NOT pure shapes.
 */

import type { SessionId, TenantId } from '../ids/index.js'
import type { SummaryId } from '../session/ids.js'
import type { DeliverableRef } from './deliverable.js'

/**
 * Max characters allowed for {@link SessionSummaryRef.agentSummary}. See
 * session-hierarchy.md §4.7 — the agent's narration is bounded to keep
 * parent prompts token-finite regardless of the child's transcript length.
 */
export const AGENT_SUMMARY_MAX_CHARS = 4000

export type SessionSummaryOutcomeStatus = 'succeeded' | 'partial' | 'failed'

export interface SessionSummaryOutcome {
	readonly status: SessionSummaryOutcomeStatus
	/** Short human-readable one-liner. Optional per pattern doc §4.7. */
	readonly verdict?: string
}

export interface SessionSummaryKeyDecision {
	readonly at: Date
	readonly summary: string
}

/**
 * Structured completion pointer emitted by the kernel when a sub-session
 * terminalizes. See session-hierarchy.md §4.7 and §8.1.
 *
 * Readonly across the board — the record is immutable once sealed.
 */
export interface SessionSummaryRef {
	readonly id: SummaryId
	readonly sessionRef: SessionId
	readonly tenantId: TenantId
	readonly outcome: SessionSummaryOutcome
	readonly deliverables: readonly DeliverableRef[]
	/** Agent's own narration; bounded to {@link AGENT_SUMMARY_MAX_CHARS}. */
	readonly agentSummary: string
	readonly keyDecisions: readonly SessionSummaryKeyDecision[]
	/** When the summary was materialized. */
	readonly at: Date
	/**
	 * Literal `'kernel'` — enforces kernel-only emission at the type level.
	 * See the module header for the invariant rationale.
	 */
	readonly materializedBy: 'kernel'
}
