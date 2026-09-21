import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLease, SessionLog } from '../../store/session-log/index.js'
import type { PendingDecision } from '../../types/hitl/index.js'
import type {
	SessionEventListener,
	SessionLogReplay,
	Turn,
	TurnState,
} from '../../types/session/index.js'
import type { QueryParams } from './index.js'
import type { TurnStateScope } from './turn-state.js'

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
	/** Required to find the checkpoint; also threaded into the resumed turn. */
	readonly checkpointStore: SessionCheckpointStore
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
 */
export async function resumeSession(_params: ResumeSessionParams): Promise<ResumeOutcome> {
	throw new Error('train: not yet wired')
}
