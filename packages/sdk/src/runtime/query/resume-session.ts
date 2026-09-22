import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLease, SessionLog } from '../../store/session-log/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { PendingDecision } from '../../types/hitl/index.js'
import type {
	SessionEventListener,
	SessionLogReplay,
	Turn,
	TurnState,
} from '../../types/session/index.js'
import { type QueryParams, drainQueryWithSelectedResumeState } from './index.js'
import { resolveSessionStorage } from './session-storage.js'
import { type TurnStateScope, loadSelectedTurnContext } from './turn-state.js'

/** What came of a {@link resumeSession} call. */
export type ResumeOutcome =
	| { readonly resumed: false; readonly reason: 'no-checkpoint' }
	| {
			readonly resumed: false
			readonly reason: 'awaiting-decision'
			/** What to put in front of a human. */
			readonly pending: PendingDecision
			readonly state: TurnState
	  }
	| {
			readonly resumed: true
			readonly turn: Turn
			readonly state: TurnState
			/** What became of `eventCursor`. Absent when no cursor was supplied. */
			readonly replay?: SessionLogReplay
	  }

/**
 * The half of a turn that cannot be serialized, plus where to look.
 *
 * `messages` is absent: on resume the context is the fold of the session log
 * through the checkpoint. `turnId` and `resumeFromCheckpoint` come from the
 * scope and the selected checkpoint.
 */
export interface ResumeSessionParams
	extends Omit<QueryParams, 'messages' | 'turnId' | 'resumeFromCheckpoint'> {
	/** Identifies the paused turn. */
	readonly scope: TurnStateScope
	/** The session log the turn lives in. */
	readonly sessionLog: SessionLog
	/**
	 * Where the turn's checkpoints are; also threaded into the resumed turn.
	 * Default: the store beside `sessionLog` — in memory for an in-memory
	 * log, otherwise under `paths` (or the working directory's project under
	 * `NAMZU_HOME`), the same store `query()` wrote them to.
	 */
	readonly checkpointStore?: SessionCheckpointStore
	/** The lease this worker took with `claimSession` before resuming. */
	readonly lease?: SessionLease
	/**
	 * Resume a specific checkpoint instead of the one the store would pick.
	 * Absent means the checkpoint an open decision references, else the newest.
	 */
	readonly checkpointId?: TurnState['checkpointId']
	/** Where to send the resumed turn's events. */
	readonly listener?: SessionEventListener
}

/**
 * Continue a paused or interrupted turn of a session, in this process: the
 * SAME session and the SAME `turnId`. The outcomes are `no-checkpoint`,
 * `awaiting-decision` and `resumed`.
 *
 * The caller brings what cannot be serialized — the provider, the tool
 * registry, the sandbox, the working directory — and the log and the
 * checkpoint store bring the state. A missing checkpoint does not silently
 * become a fresh turn, and a park is not resumed past without the answer it
 * is waiting for (`pendingDecision`).
 */
export async function resumeSession(params: ResumeSessionParams): Promise<ResumeOutcome> {
	const { scope, sessionLog, checkpointId, pendingDecision, listener, onEventReplay, ...rest } =
		params
	const checkpointStore =
		params.checkpointStore ??
		(
			await resolveSessionStorage({
				sessionId: scope.sessionId,
				...(scope.parentSessionId ? { parentSessionId: scope.parentSessionId } : {}),
				sessionLog,
				...(params.paths ? { paths: params.paths } : {}),
				...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
			})
		).checkpoints

	const selected = await loadSelectedTurnContext(sessionLog, checkpointStore, scope, checkpointId)
	const state = selected?.state
	if (!state?.checkpointId || !selected) return { resumed: false, reason: 'no-checkpoint' }
	assertResumeRequestAttribution(params, state)

	// A park is outstanding until it is answered.
	const outstanding = state.pending && !state.pending.resolvedAt ? state.pending : undefined
	if (outstanding && !pendingDecision) {
		return { resumed: false, reason: 'awaiting-decision', pending: outstanding, state }
	}

	let replay: SessionLogReplay | undefined
	const turn = await drainQueryWithSelectedResumeState(
		{
			...rest,
			messages: [],
			turnId: state.turnId,
			sessionId: state.sessionId,
			topicId: state.topicId,
			projectId: state.projectId,
			tenantId: state.tenantId,
			...(state.parentSessionId !== undefined ? { parentSessionId: state.parentSessionId } : {}),
			...(state.parentTurnId !== undefined ? { parentTurnId: state.parentTurnId } : {}),
			resumeFromCheckpoint: state.checkpointId,
			sessionLog,
			checkpointStore,
			...(pendingDecision ? { pendingDecision } : {}),
			onEventReplay: (verdict: SessionLogReplay) => {
				replay = verdict
				return onEventReplay?.(verdict)
			},
		} as QueryParams,
		{
			...state,
			checkpointId: state.checkpointId,
			...(selected.checkpoint.trace ? { traceContext: selected.checkpoint.trace } : {}),
			messageIds: selected.messageIds,
		},
		listener,
	)

	return { resumed: true, turn, state, ...(replay !== undefined ? { replay } : {}) }
}

function assertResumeRequestAttribution(params: ResumeSessionParams, state: TurnState): void {
	const mismatchedFields: string[] = []
	if (params.scope.turnId !== state.turnId) mismatchedFields.push('turnId')
	if (params.sessionId !== state.sessionId) mismatchedFields.push('sessionId')
	if (params.sessionLog.sessionId !== state.sessionId) mismatchedFields.push('sessionLog')
	if (params.topicId !== state.topicId) mismatchedFields.push('topicId')
	if (params.projectId !== state.projectId) mismatchedFields.push('projectId')
	if (params.tenantId !== state.tenantId) mismatchedFields.push('tenantId')
	if (params.parentSessionId !== undefined && params.parentSessionId !== state.parentSessionId) {
		mismatchedFields.push('parentSessionId')
	}
	if (mismatchedFields.length === 0) return

	throw new NamzuError({
		code: 'invalid_config',
		message:
			'The resume request attribution does not match the checkpoint scope selected for this turn.',
		details: { fields: mismatchedFields },
	})
}
