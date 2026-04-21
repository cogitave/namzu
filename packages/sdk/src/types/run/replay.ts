import type { CheckpointId, RunId, ToolCallId } from '../ids/index.js'
import type { ToolResult } from '../tool/index.js'

/**
 * Controlled mutation applied at the fork point during {@link replay}.
 *
 * v1 ships a single variant: `injectToolResponse` — the 80% debugging use
 * case. Additional variants (`swapProvider`, `overrideBudget`, etc.) are
 * deferred; see ses_005-deterministic-replay §3.3.
 */
export type Mutation = {
	type: 'injectToolResponse'
	toolCallId: ToolCallId
	response: ToolResult
}

/**
 * Lightweight listing entry returned by {@link listCheckpoints}. Projected
 * from {@link import('../hitl/index.js').IterationCheckpoint} — not a full
 * checkpoint payload, just enough to pick a fork point.
 *
 * Named `CheckpointListEntry` (not `CheckpointSummary`) to avoid collision
 * with the pre-existing HITL `CheckpointSummary` shape at
 * `types/hitl/index.ts`.
 */
export interface CheckpointListEntry {
	id: CheckpointId
	runId: RunId
	iteration: number
	createdAt: number
	messageCount: number
}

/**
 * Attribution record stamped on a {@link Run} produced by {@link replay}.
 * Non-replay runs have `replayOf === undefined`. Shape mirrors voltagent's
 * `replayedFromExecutionId` / `replayFromStepId` pattern, folded into a
 * single optional rather than three parallel ones.
 */
export interface ReplayAttribution {
	sourceRunId: RunId
	fromCheckpointId: CheckpointId
	mutations: Mutation[]
	replayedAt: number
}

/**
 * Thrown when a {@link Mutation} cannot be applied at the resolved fork
 * point. Currently raised by `injectToolResponse` when the supplied
 * `toolCallId` does not match any pending tool call in the checkpoint's
 * last assistant message.
 */
export class MutationNotApplicableError extends Error {
	constructor(
		message: string,
		public readonly availableToolCallIds: readonly ToolCallId[],
	) {
		super(message)
		this.name = 'MutationNotApplicableError'
	}
}
