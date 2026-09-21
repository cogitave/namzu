import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type {
	CheckpointId,
	ProjectId,
	SessionId,
	TenantId,
	TopicId,
	TurnId,
} from '../../types/ids/index.js'
import type { Checkpoint } from '../../types/session/checkpoint.js'
import type { TurnState } from '../../types/session/turn-state.js'

/**
 * Where a turn's durable state lives: the full attribution, so a shared
 * backend can enforce isolation.
 */
export interface TurnStateScope {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/** Present on a child session's turn. */
	readonly parentSessionId?: SessionId
	/** Present on a child session's turn. */
	readonly parentTurnId?: TurnId
}

/** Snapshot a live turn into a {@link TurnState} a different process can resume. */
export function captureTurnState(
	_recorder: TurnRecorder,
	_scope: TurnStateScope,
	_extra?: { elapsedMs?: number; checkpoint?: Checkpoint | null },
): TurnState {
	throw new Error('train: not yet wired')
}

/**
 * Read a turn's state back from its checkpoint and the session log. The
 * parked checkpoint if there is one, else the newest; `null` when the turn
 * has none.
 */
export async function loadTurnState(
	_log: SessionLog,
	_store: SessionCheckpointStore,
	_scope: TurnStateScope,
	_checkpointId?: CheckpointId,
): Promise<TurnState | null> {
	throw new Error('train: not yet wired')
}

/** {@link loadTurnState}, also returning the checkpoint document it was read from. */
export async function loadSelectedTurnState(
	_log: SessionLog,
	_store: SessionCheckpointStore,
	_scope: TurnStateScope,
	_checkpointId?: CheckpointId,
): Promise<{ readonly state: TurnState; readonly checkpoint: Checkpoint } | null> {
	throw new Error('train: not yet wired')
}
