/**
 * Runtime errors emitted by the session-summary materialization path.
 *
 * Split from `session/summary/ref.ts` on 2026-04-21 (ses_010 commit 1): the
 * shape types moved to `types/summary/ref.ts`; runtime behaviour (error
 * classes, materializer) remains under `session/summary/`. This keeps the
 * type-layering rule consistent — `types/` holds only pure shapes.
 */

import type { SessionId } from '../../types/ids/index.js'
import type { SummaryId } from '../../types/session/ids.js'

/**
 * Raised by `SessionSummaryMaterializer.materialize` when the provided
 * `agentSummary` exceeds the max-character bound declared at
 * `types/summary/ref.ts#AGENT_SUMMARY_MAX_CHARS`. Convention #5
 * deny-by-default — the kernel does not truncate silently.
 */
export class AgentSummaryTooLongError extends Error {
	readonly details: {
		readonly actual: number
		readonly max: number
	}

	constructor(details: { actual: number; max: number }) {
		super(`agentSummary ${details.actual} chars exceeds max ${details.max}`)
		this.name = 'AgentSummaryTooLongError'
		this.details = details
	}
}

/**
 * Raised when `SessionSummaryMaterializer.materialize` is invoked against a
 * session that already has a persisted summary. Re-materialization would
 * duplicate history — callers wanting to append must open a new intervention
 * sub-session (see session-hierarchy.md §4.5).
 */
export class SessionAlreadySummarizedError extends Error {
	readonly details: {
		readonly sessionId: SessionId
		readonly existingSummaryId: SummaryId
	}

	constructor(details: { sessionId: SessionId; existingSummaryId: SummaryId }) {
		super(
			`Session ${details.sessionId} already has summary ${details.existingSummaryId}; re-materialization rejected`,
		)
		this.name = 'SessionAlreadySummarizedError'
		this.details = details
	}
}
