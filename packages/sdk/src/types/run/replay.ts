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
 * A fork was pointed at its own source run.
 *
 * A fork exists to leave the source alone: it is a NEW run, from a checkpoint of an old
 * one, and running it under the source's id would overwrite the very record it forked
 * from — its `run.json`, its `messages.json`, its index entry. That is not a fork, it is
 * the re-drive that ses_017 G2 exists to stop, wearing a fork's clothes. Refused at both
 * doors: when the fork state is prepared, and again in `query()` if attribution ever
 * reaches it naming the run it is driving.
 */
export class ForkTargetsSourceRunError extends Error {
	readonly runId: RunId

	constructor(runId: RunId) {
		super(
			`A fork must run under a NEW run id — ${runId} is the run it forks FROM. Running a fork under its source's id would overwrite the record the fork exists to preserve.`,
		)
		this.name = 'ForkTargetsSourceRunError'
		this.runId = runId
	}
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
