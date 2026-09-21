import type { CheckpointScope, SessionCheckpointStore } from '../../../store/checkpoint/index.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import type { Mutation } from '../../../types/session/fork.js'
import type { TurnForkOrigin } from '../../../types/session/turn.js'
import type { Logger } from '../../../utils/logger.js'
import { restoreCheckpointContext } from '../checkpoint.js'
import { applyMutations } from './mutate.js'

/** Which checkpoint to fork at: an id, or the turn's newest. */
export type CheckpointSelector = CheckpointId | 'latest'

export interface PrepareReplayInput {
	/** The source session's log: the checkpoint's context is its fold. */
	readonly sessionLog: SessionLog
	/** The store the source turn's checkpoints are in. */
	readonly checkpointStore: SessionCheckpointStore
	/** The source turn, across the full attribution. */
	readonly scope: CheckpointScope
	/** Which checkpoint to fork at. */
	readonly fromCheckpoint: CheckpointSelector
	/** Mutations applied at the fork point before the caller hands the state to `query()`. */
	readonly mutate?: Mutation[]
	readonly logger?: Logger
}

export interface PreparedReplayState {
	/**
	 * The context at the fork point, with mutations applied: the fold of the
	 * source session's log through the checkpoint. Seed a NEW session with it
	 * (`query({ sessionId: <new>, messages, forkedFrom })`).
	 */
	readonly messages: Message[]
	/** The checkpoint the fork starts from. */
	readonly sourceCheckpoint: Checkpoint
	/**
	 * Where the fork comes from. Pass it as `query({ forkedFrom })`: the new
	 * session's `session_started.forkedFrom` names it, and the returned turn
	 * carries it.
	 */
	readonly forkedFrom: TurnForkOrigin
	/** The mutations that were applied. */
	readonly mutations: readonly Mutation[]
}

/**
 * Produce what a fork needs: the context at a checkpoint of a source turn,
 * with mutations applied, and the origin the new session records. A fork is
 * always a NEW session; the source session is only read.
 *
 * The checkpoint is restored under the same rules a resume uses: its
 * document must match its `checkpoint_written` record and the log prefix it
 * covers must be intact.
 */
export async function prepareReplayState(input: PrepareReplayInput): Promise<PreparedReplayState> {
	const sourceCheckpoint = await resolveCheckpoint(input)
	const restored = await restoreCheckpointContext(input.sessionLog, sourceCheckpoint)
	const mutations = input.mutate ?? []
	const messages = applyMutations(restored.messages, mutations)
	return {
		messages,
		sourceCheckpoint,
		forkedFrom: {
			sessionId: sourceCheckpoint.sessionId,
			turnId: sourceCheckpoint.turnId,
			checkpointId: sourceCheckpoint.checkpointId,
		},
		mutations,
	}
}

async function resolveCheckpoint(input: PrepareReplayInput): Promise<Checkpoint> {
	if (input.fromCheckpoint === 'latest') {
		const all = await input.checkpointStore.list(input.scope)
		const newest = [...all].sort((a, b) => b.iteration - a.iteration)[0]
		if (!newest) {
			throw new Error(
				`No checkpoints found for turn ${input.scope.turnId} of session ${input.scope.sessionId}`,
			)
		}
		return (await input.checkpointStore.restore(input.scope, newest.checkpointId)) as Checkpoint
	}
	const checkpoint = await input.checkpointStore.restore(input.scope, input.fromCheckpoint)
	if (!checkpoint) {
		throw new Error(
			`Checkpoint ${input.fromCheckpoint} not found for turn ${input.scope.turnId} of session ${input.scope.sessionId}`,
		)
	}
	return checkpoint
}
