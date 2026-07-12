import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { DecisionRequestId, RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import { ForkTargetsSourceRunError, type ReplayAttribution } from '../../../types/run/replay.js'
import { generateRunId } from '../../../utils/id.js'
import { type PrepareReplayInput, prepareReplayState } from './prepare.js'

export interface PrepareForkInput extends PrepareReplayInput {
	/**
	 * The id the fork will run under. Minted when absent.
	 *
	 * Supplying the SOURCE run's id is refused ({@link ForkTargetsSourceRunError}), not
	 * honoured — that is the overwrite this entry point exists to make impossible.
	 */
	newRunId?: RunId
}

/** What a caller threads into `query()` to actually run the fork. */
export interface PreparedFork {
	/** The NEW run. Nothing about the source is written under this id. */
	runId: RunId
	sourceRunId: RunId
	/** History at the fork point, repaired and mutation-applied. Seed as `messages`. */
	messages: Message[]
	/** Provenance. Pass as `query({ replayOf })` — it is persisted on the fork's `run.json`. */
	attribution: ReplayAttribution
	sourceCheckpoint: IterationCheckpoint
	/**
	 * Set when the source checkpoint was parked on a live decision that this fork does not
	 * carry across. The fork is a timeline in which the human never answered: the pending
	 * call is repaired away, exactly as `prepareReplayState` describes. To *answer* the
	 * decision instead, resume the source run — {@link
	 * import('../decision/resume.js').resumeDecision}.
	 */
	discardedPendingDecision?: DecisionRequestId
}

/**
 * **Fork** a new run from a checkpoint of an existing one. The state-preparation half;
 * pure read of the source ([state-prep-execution-split](../../../../../docs.local/conventions/state-prep-execution-split.md)).
 *
 * This is the other half of a split that used to be one door with one id (ses_017 G2).
 * `query({ resumeFromCheckpoint })` served BOTH "continue this run" and "re-drive this
 * checkpoint", under the same run id — so re-driving a finished run overwrote its
 * `run.json`, replaced its `messages.json` and rewrote its index entry, and the only
 * status protected from it was `cancelled`. The two things are not variants of each
 * other:
 *
 *   - **Resume** continues THE run. Same id, same ledger, same record; it requires the run
 *     to be non-terminal and it must take the run's lease. What it writes, it writes over
 *     its own history — which is correct, because it IS that run.
 *   - **Fork** starts a NEW run FROM the old one's checkpoint. New id, new directory, new
 *     lease, new budget; the source is opened read-only and its record is not touched.
 *     What it inherits is the *history*, not the identity.
 *
 * A fork's budget is genuinely new, and that is the semantics, not an omission: it is a
 * different run, so `tokenBudget` / `costLimitUsd` / `maxIterations` are its own. (A
 * resume, by contrast, continues the source's lifetime ledger — see
 * `RunPersistence.restoreFromCheckpoint`.) Fork a run in a loop and you will pay for it
 * every time; that is what forking is.
 *
 * ```ts
 * const fork = await prepareForkState({ baseDir, runId: source, fromCheckpoint: 'latest' })
 * await drainQuery({
 *   runId: fork.runId,            // ← the NEW run
 *   messages: fork.messages,      // ← the source's history at the fork point
 *   replayOf: fork.attribution,   // ← provenance, persisted on the fork's run.json
 *   provider, tools, runConfig, agentId, agentName,
 *   sessionId, threadId, projectId, tenantId, workingDirectory,
 * })
 * ```
 *
 * Note what is NOT passed: `resumeFromCheckpoint`. A fork does not resume — it seeds a new
 * run with a history. Passing the source's checkpoint id here would look for that
 * checkpoint under the FORK's directory, where it does not exist.
 */
export async function prepareForkState(input: PrepareForkInput): Promise<PreparedFork> {
	if (input.newRunId !== undefined && input.newRunId === input.runId) {
		throw new ForkTargetsSourceRunError(input.runId)
	}

	const prepared = await prepareReplayState(input)

	return {
		runId: input.newRunId ?? generateRunId(),
		sourceRunId: input.runId,
		messages: prepared.messages,
		attribution: prepared.attribution,
		sourceCheckpoint: prepared.sourceCheckpoint,
		discardedPendingDecision: prepared.discardedPendingDecision,
	}
}
