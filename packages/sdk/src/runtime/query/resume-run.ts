import type { PendingDecision } from '../../types/hitl/index.js'
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { Run } from '../../types/run/entity.js'
import type { RunState } from '../../types/run/state.js'
import { type QueryParams, drainQuery } from './index.js'
import { type RunStateScope, loadRunState } from './run-state.js'

/**
 * What a resume attempt found.
 *
 * Three outcomes rather than a nullable `Run`, because the two failures
 * mean opposite things to a caller. "No checkpoint" is a dead end — there
 * is nothing to continue and starting fresh would be a different run
 * wearing the same id. "Awaiting decision" is the run working as designed:
 * it parked on a question, and continuing means answering it first.
 */
export type ResumeOutcome =
	| { readonly resumed: false; readonly reason: 'no-checkpoint' }
	| {
			readonly resumed: false
			readonly reason: 'awaiting-decision'
			/** What to put in front of a human. */
			readonly pending: PendingDecision
			readonly state: RunState
	  }
	| { readonly resumed: true; readonly run: Run; readonly state: RunState }

/**
 * The half of a run that cannot be serialized, plus where to look.
 *
 * `messages` is deliberately absent. On resume the history comes from the
 * checkpoint and any passed messages would be discarded, so accepting them
 * would invite a caller to hand over a transcript that is silently ignored.
 */
export interface ResumeRunParams
	extends Omit<QueryParams, 'messages' | 'runId' | 'resumeFromCheckpoint'> {
	/** Identifies the run inside the checkpoint store. */
	readonly scope: RunStateScope
	/** Required to find the checkpoint; also threaded into the resumed run. */
	readonly checkpointStore: CheckpointStore
	/**
	 * Resume a specific checkpoint instead of the one the store would pick.
	 * Absent means the parked checkpoint if there is one, else the newest.
	 */
	readonly checkpointId?: RunState['checkpointId']
}

/**
 * Continue a run that a different process started.
 *
 * Everything this needs already existed — `CheckpointManager` writes the
 * history, budgets, working state, trace context and any park;
 * `loadRunState` reads them back; `query` accepts `runId` +
 * `resumeFromCheckpoint` and restores all of it. What was missing was the
 * few lines that join them, so every host wrote their own — and in this
 * repo nothing outside the SDK ever did, which means the whole path shipped
 * untravelled.
 *
 * The division of labour is the one the mechanism already implies: the
 * CALLER brings what cannot be serialized — the provider client, the tool
 * registry, the sandbox, the working directory — and the STORE brings the
 * state. A snapshot deliberately holds no socket, no client and no open
 * file, so it could never have carried the first half.
 *
 * Refusing beats guessing at both failure points. A missing checkpoint does
 * not silently become a fresh run under a recycled id, and a park is not
 * resumed past without the answer it is waiting for.
 */
export async function resumeRun(params: ResumeRunParams): Promise<ResumeOutcome> {
	const { scope, checkpointStore, checkpointId, pendingDecision, ...rest } = params

	const state = await loadRunState(checkpointStore, scope, checkpointId)
	if (!state?.checkpointId) return { resumed: false, reason: 'no-checkpoint' }

	// A park is outstanding until it is answered. `resolvedAt` is what marks
	// an answered one, so a checkpoint that carries a resolved decision is an
	// ordinary resume, not a question waiting on anybody.
	const outstanding = state.pending && !state.pending.resolvedAt ? state.pending : undefined
	if (outstanding && !pendingDecision) {
		return { resumed: false, reason: 'awaiting-decision', pending: outstanding, state }
	}

	const run = await drainQuery({
		...rest,
		messages: [],
		runId: state.runId,
		resumeFromCheckpoint: state.checkpointId,
		checkpointStore,
		...(pendingDecision ? { pendingDecision } : {}),
	} as QueryParams)

	return { resumed: true, run, state }
}
