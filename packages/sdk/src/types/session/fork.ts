import type { CheckpointId, SessionId, ToolCallId, TurnId } from '../ids/index.js'
import type { ToolResult } from '../tool/index.js'

/**
 * Controlled mutation applied at the fork point when a session is forked
 * from a checkpoint. A fork always creates a NEW session whose
 * `session_started.forkedFrom` names the source.
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
 * Lightweight listing entry returned by `listCheckpoints`. Projected from a
 * checkpoint document — not the full payload, just enough to pick a fork
 * point.
 *
 * Named `CheckpointListEntry` (not `CheckpointSummary`) to avoid collision
 * with the pre-existing HITL `CheckpointSummary` shape at
 * `types/hitl/index.ts`.
 */
export interface CheckpointListEntry {
	id: CheckpointId
	sessionId: SessionId
	turnId: TurnId
	iteration: number
	createdAt: number
	/** Records of the session log the checkpoint covers (`throughSeq`). */
	throughSeq: number
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
