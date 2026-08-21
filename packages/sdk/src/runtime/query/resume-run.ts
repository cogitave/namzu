import { NamzuError } from '../../types/errors/index.js'
import type { PendingDecision } from '../../types/hitl/index.js'
import type { CheckpointStore, FencingToken } from '../../types/run/checkpoint-store.js'
import type { Run } from '../../types/run/entity.js'
import type { RunEventReplay } from '../../types/run/event-cursor.js'
import type { RunEventListener } from '../../types/run/events.js'
import type { RunState } from '../../types/run/state.js'
import { type QueryParams, drainQueryWithSelectedResumeState } from './index.js'
import { type RunStateScope, loadSelectedRunState } from './run-state.js'

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
	| {
			readonly resumed: true
			readonly run: Run
			readonly state: RunState
			/**
			 * What became of {@link ResumeRunParams.eventCursor}. Absent when no
			 * cursor was supplied.
			 *
			 * Reported rather than thrown: a stale cursor is the client's
			 * problem and the run still had to be resumed. A caller that sees
			 * `unavailable` re-derives its view from the run's transcript
			 * instead of folding a hole into it.
			 */
			readonly replay?: RunEventReplay
	  }

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
	 * The fence of the claim this worker took on the run before resuming.
	 *
	 * A resume is the one moment two workers are most likely to collide — it
	 * is what a queue reader does with a parked run — so this is the call that
	 * most needs to carry one.
	 */
	readonly claimFence?: FencingToken
	/**
	 * Resume a specific checkpoint instead of the one the store would pick.
	 * Absent means the parked checkpoint if there is one, else the newest.
	 */
	readonly checkpointId?: RunState['checkpointId']

	/**
	 * Where to send the resumed run's events.
	 *
	 * This call had none, and the consequence was total: it drains the run to
	 * completion and every event the run emits — every tool call, every park,
	 * every token update — was discarded, because `drainQuery` forwards to a
	 * listener and none was ever passed. So the one API for continuing a run
	 * another process started could not show anybody what the run was doing.
	 *
	 * It is also what makes {@link ResumeRunParams.eventCursor} mean anything:
	 * a catch-up delivered into a stream nobody receives is not a catch-up.
	 */
	readonly listener?: RunEventListener
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
	const {
		scope,
		checkpointStore,
		checkpointId,
		pendingDecision,
		claimFence,
		listener,
		onEventReplay,
		...rest
	} = params

	const selected = await loadSelectedRunState(checkpointStore, scope, checkpointId)
	const state = selected?.state
	if (!state?.checkpointId || !selected) return { resumed: false, reason: 'no-checkpoint' }
	assertResumeRequestAttribution(params, state)

	// A park is outstanding until it is answered. `resolvedAt` is what marks
	// an answered one, so a checkpoint that carries a resolved decision is an
	// ordinary resume, not a question waiting on anybody.
	const outstanding = state.pending && !state.pending.resolvedAt ? state.pending : undefined
	if (outstanding && !pendingDecision) {
		return {
			resumed: false,
			reason: 'awaiting-decision',
			pending: outstanding,
			state,
		}
	}

	let replay: RunEventReplay | undefined

	const run = await drainQueryWithSelectedResumeState(
		{
			...rest,
			messages: [],
			runId: state.runId,
			sessionId: state.sessionId,
			topicId: state.topicId,
			projectId: state.projectId,
			tenantId: state.tenantId,
			// Forwarded, and it is not cosmetic: the run store nests a sub-run's
			// evidence under `<parent>/children/<run>`, so resuming a sub-run
			// without this binds `<base>/<run>` instead — a second, empty
			// transcript under a run id that already has one, a sequence that
			// restarts at 1, and a catch-up that reports a live run as having
			// produced nothing.
			...(state.parentRunId !== undefined ? { parentRunId: state.parentRunId } : {}),
			resumeFromCheckpoint: state.checkpointId,
			checkpointStore,
			...(claimFence !== undefined ? { claimFence } : {}),
			...(pendingDecision ? { pendingDecision } : {}),
			onEventReplay: (verdict: RunEventReplay) => {
				replay = verdict
				return onEventReplay?.(verdict)
			},
		} as QueryParams,
		{
			...state,
			checkpointId: state.checkpointId,
			...(selected.checkpoint.traceContext
				? { traceContext: selected.checkpoint.traceContext }
				: {}),
		},
		listener,
	)

	return {
		resumed: true,
		run,
		state,
		...(replay !== undefined ? { replay } : {}),
	}
}

function assertResumeRequestAttribution(params: ResumeRunParams, state: RunState): void {
	const mismatchedFields: string[] = []
	if (params.scope.runId !== state.runId) mismatchedFields.push('runId')
	if (params.sessionId !== state.sessionId) mismatchedFields.push('sessionId')
	if (params.topicId !== state.topicId) mismatchedFields.push('topicId')
	if (params.projectId !== state.projectId) mismatchedFields.push('projectId')
	if (params.tenantId !== state.tenantId) mismatchedFields.push('tenantId')
	if (params.parentRunId !== undefined && params.parentRunId !== state.parentRunId) {
		mismatchedFields.push('parentRunId')
	}
	if (mismatchedFields.length === 0) return

	throw new NamzuError({
		code: 'invalid_config',
		message:
			'The resume request attribution does not match the checkpoint scope selected for this run.',
		details: { fields: mismatchedFields },
	})
}
