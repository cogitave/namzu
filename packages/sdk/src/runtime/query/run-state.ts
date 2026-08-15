import type { RunPersistence } from '../../manager/run/persistence.js'
import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../types/run/checkpoint-store.js'
import { RUN_STATE_VERSION, type RunState } from '../../types/run/state.js'
import type { ThreadId } from '../../types/session/ids.js'
import { findPendingCheckpoint } from './checkpoint.js'

/**
 * A {@link CheckpointRunScope} plus the one attribution field checkpoints
 * do not record.
 *
 * `topicId` is denormalized onto a run at `query()` time and never written
 * into a checkpoint, so a snapshot rebuilt from the store alone cannot
 * derive it. Requiring the caller to supply it is better than inventing one
 * or widening `RunState` to make it optional: the field is required by
 * `query()` on the way back in, so an absent value would only fail later
 * and less clearly.
 */
export interface RunStateScope extends CheckpointRunScope {
	topicId: ThreadId
}

/**
 * Build a JSON-safe snapshot of a live run.
 *
 * Every field is copied, not referenced: the caller is about to serialize
 * this, and a snapshot that aliased the run's own message array would keep
 * mutating after it was taken.
 */
export function captureRunState(
	runMgr: RunPersistence,
	scope: RunStateScope,
	extra?: {
		elapsedMs?: number
		checkpoint?: IterationCheckpoint | null
	},
): RunState {
	const session = runMgr.getSession()
	const startedAt = session.startedAt

	return {
		version: RUN_STATE_VERSION,
		runId: runMgr.id,
		sessionId: scope.sessionId,
		topicId: scope.topicId,
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
		...(session.metadata?.agentId ? { agentId: session.metadata.agentId } : {}),
		...(session.metadata?.agentName ? { agentName: session.metadata.agentName } : {}),
		status: runMgr.status,
		...(runMgr.stopReason ? { stopReason: runMgr.stopReason } : {}),
		...(session.lastError ? { lastError: session.lastError } : {}),
		messages: structuredClone(runMgr.messages),
		tokenUsage: { ...runMgr.tokenUsage },
		costInfo: { ...runMgr.costInfo },
		currentIteration: runMgr.currentIteration,
		startedAt,
		elapsedMs: extra?.elapsedMs ?? Date.now() - startedAt,
		...(extra?.checkpoint ? { checkpointId: extra.checkpoint.id } : {}),
		...(extra?.checkpoint?.pending ? { pending: extra.checkpoint.pending } : {}),
		capturedAt: Date.now(),
	}
}

/**
 * Rebuild a run's snapshot from durable state alone, with no live run
 * object — the read a DIFFERENT process performs.
 *
 * With no `checkpointId` this prefers the run's outstanding park over its
 * newest checkpoint, because "what is this run waiting on" is the question
 * a resuming process is actually asking; it falls back to the newest
 * checkpoint when nothing is parked.
 *
 * Returns `null` when the run has no checkpoints. That is the honest
 * answer: a run that never checkpointed left nothing to resume from, and
 * synthesizing a snapshot from an empty store would produce a run that
 * restarts from zero while claiming to be a continuation.
 *
 * `status`/`stopReason` are absent from a checkpoint by construction — a
 * checkpoint is written mid-flight — so a rebuilt snapshot always reports
 * `running`, and the host's own record remains the authority on a run that
 * already finished. Read `pending` to tell a parked run from a live one:
 * it is outstanding when set with no `resolvedAt`.
 */
export async function loadRunState(
	store: CheckpointStore,
	scope: RunStateScope,
	checkpointId?: CheckpointId,
): Promise<RunState | null> {
	const checkpoint = checkpointId
		? await store.readCheckpoint(scope, checkpointId)
		: ((await findPendingCheckpoint(store, scope)) ?? (await newest(store, scope)))

	if (!checkpoint) return null

	return {
		version: RUN_STATE_VERSION,
		runId: checkpoint.runId,
		sessionId: scope.sessionId,
		topicId: scope.topicId,
		projectId: scope.projectId,
		tenantId: scope.tenantId,
		...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
		status: 'running',
		messages: checkpoint.messages,
		tokenUsage: checkpoint.tokenUsage,
		costInfo: checkpoint.costInfo,
		currentIteration: checkpoint.guardState.iterationCount,
		startedAt: checkpoint.createdAt - checkpoint.guardState.elapsedMs,
		elapsedMs: checkpoint.guardState.elapsedMs,
		checkpointId: checkpoint.id,
		...(checkpoint.pending ? { pending: checkpoint.pending } : {}),
		capturedAt: Date.now(),
	}
}

async function newest(
	store: CheckpointStore,
	scope: CheckpointRunScope,
): Promise<IterationCheckpoint | null> {
	const all = await store.listCheckpoints(scope)
	return all.length > 0 ? ((all[all.length - 1] as IterationCheckpoint) ?? null) : null
}
