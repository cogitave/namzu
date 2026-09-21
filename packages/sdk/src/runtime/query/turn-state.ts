import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type {
	CheckpointId,
	MessageId,
	ProjectId,
	SessionId,
	TenantId,
	TopicId,
	TurnId,
} from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { Checkpoint } from '../../types/session/checkpoint.js'
import { TURN_STATE_VERSION, type TurnState } from '../../types/session/turn-state.js'
import { findPendingCheckpoint, restoreCheckpointContext } from './checkpoint.js'

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

/**
 * Snapshot a live turn into a {@link TurnState} a different process can
 * resume. Every field is copied, not referenced: the caller is about to
 * serialize it.
 */
export function captureTurnState(
	recorder: TurnRecorder,
	scope: TurnStateScope,
	extra?: { elapsedMs?: number; checkpoint?: Checkpoint | null },
): TurnState {
	const turn = recorder.getTurn()
	const startedAt = turn.startedAt
	const binding = recorder.budget?.binding
	return {
		version: TURN_STATE_VERSION,
		sessionId: scope.sessionId,
		turnId: recorder.turnId,
		topicId: scope.topicId,
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		...(scope.parentSessionId ? { parentSessionId: scope.parentSessionId } : {}),
		...(scope.parentTurnId ? { parentTurnId: scope.parentTurnId } : {}),
		agentId: turn.metadata.agentId,
		agentName: turn.metadata.agentName,
		status: recorder.status,
		...(recorder.stopReason ? { stopReason: recorder.stopReason } : {}),
		...(turn.lastError ? { lastError: turn.lastError } : {}),
		messages: structuredClone(recorder.messages),
		tokenUsage: { ...recorder.tokenUsage },
		costInfo: { ...recorder.costInfo },
		currentIteration: recorder.currentIteration,
		startedAt,
		elapsedMs: extra?.elapsedMs ?? Date.now() - startedAt,
		...(extra?.checkpoint ? { checkpointId: extra.checkpoint.checkpointId } : {}),
		...(binding ? { budgetBinding: binding } : {}),
		capturedAt: Date.now(),
	}
}

/**
 * Read a turn's state back from its checkpoint and the session log. The
 * parked checkpoint if there is one, else the newest; `null` when the turn
 * has none — a turn that never checkpointed left nothing to resume from.
 *
 * `status` is `running`: a checkpoint is written mid-flight. Read `pending`
 * to tell a parked turn from a live one.
 */
export async function loadTurnState(
	log: SessionLog,
	store: SessionCheckpointStore,
	scope: TurnStateScope,
	checkpointId?: CheckpointId,
): Promise<TurnState | null> {
	return (await loadSelectedTurnState(log, store, scope, checkpointId))?.state ?? null
}

/** {@link loadTurnState}, also returning the checkpoint document it was read from. */
export async function loadSelectedTurnState(
	log: SessionLog,
	store: SessionCheckpointStore,
	scope: TurnStateScope,
	checkpointId?: CheckpointId,
): Promise<{ readonly state: TurnState; readonly checkpoint: Checkpoint } | null> {
	const selected = await loadSelectedTurnContext(log, store, scope, checkpointId)
	return selected ? { state: selected.state, checkpoint: selected.checkpoint } : null
}

/**
 * @internal {@link loadSelectedTurnState} plus the record ids of the restored
 * messages, which a resume in this process adopts so the log keeps one
 * record per message.
 */
export async function loadSelectedTurnContext(
	log: SessionLog,
	store: SessionCheckpointStore,
	scope: TurnStateScope,
	checkpointId?: CheckpointId,
): Promise<{
	readonly state: TurnState
	readonly checkpoint: Checkpoint
	readonly messageIds: ReadonlyMap<Message, MessageId>
} | null> {
	const storeScope = {
		tenantId: scope.tenantId,
		projectId: scope.projectId,
		sessionId: scope.sessionId,
		turnId: scope.turnId,
	}
	let id = checkpointId
	if (id === undefined) {
		const parked = await findPendingCheckpoint(log, { turnId: scope.turnId })
		id = parked?.checkpointId ?? (await store.list(storeScope)).at(-1)?.checkpointId
	}
	if (id === undefined) return null
	const checkpoint = await store.restore(storeScope, id)
	if (!checkpoint) return null
	const restored = await restoreCheckpointContext(log, checkpoint)
	const state: TurnState = {
		version: TURN_STATE_VERSION,
		sessionId: scope.sessionId,
		turnId: scope.turnId,
		topicId: scope.topicId,
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		...(scope.parentSessionId ? { parentSessionId: scope.parentSessionId } : {}),
		...(scope.parentTurnId ? { parentTurnId: scope.parentTurnId } : {}),
		status: 'running',
		messages: restored.messages,
		tokenUsage: checkpoint.tokenUsage,
		costInfo: checkpoint.costInfo,
		currentIteration: checkpoint.guards.iteration,
		startedAt: Date.parse(checkpoint.turnCreatedAt),
		elapsedMs: checkpoint.guards.elapsedMs,
		checkpointId: checkpoint.checkpointId,
		...(restored.pending ? { pending: restored.pending } : {}),
		...(checkpoint.budget?.binding ? { budgetBinding: checkpoint.budget.binding } : {}),
		capturedAt: Date.now(),
	}
	return { state, checkpoint, messageIds: restored.messageIds }
}
