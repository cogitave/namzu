import type { CompactionConfig } from '../config/runtime.js'
import { WorkingStateManager } from './manager.js'
import type { FileSlot, PlanSlot, ToolResultSlot, WorkingState } from './types.js'

/**
 * The working state in a form that survives a process boundary.
 *
 * Compaction replaces older history with a summary built from this state,
 * and drops any PRIOR summary on the grounds that the new one supersedes
 * it — `serializeState` is cumulative, so within one process that is true.
 *
 * Across a resume it was not. The manager was rebuilt empty on every
 * `query()`, so the second compaction of a resumed run summarized only
 * post-resume activity and deleted the summary that held everything
 * before it. The restore path goes out of its way to carry that summary
 * forward (it is the only surviving record of the history the first pass
 * deleted) and the next pass destroyed it. Snapshotting the state onto the
 * checkpoint is what makes "cumulative" true in the case that matters.
 *
 * A deliberate WIRE type rather than a structural alias of
 * {@link WorkingState}: this lands in a persisted checkpoint, so `files`
 * has to be an array rather than a `Map` (a `Map` JSON-serializes to
 * `{}`), and the shape has to be able to change independently of the
 * in-memory one.
 */
export interface WorkingStateSnapshot {
	readonly task: string
	readonly plan: readonly PlanSlot[]
	readonly files: readonly FileSlot[]
	readonly decisions: readonly string[]
	readonly failures: readonly string[]
	readonly discoveries: readonly string[]
	readonly environment: readonly string[]
	readonly toolResults: readonly ToolResultSlot[]
	readonly userRequirements: readonly string[]
	readonly assistantNotes: readonly string[]
	/**
	 * Per-slot drop counts. These MUST survive: the serializer reports them,
	 * and a resumed summary that forgot what it had already lost would claim
	 * completeness it does not have.
	 */
	readonly evicted: Readonly<Record<string, number>>
}

export function snapshotWorkingState(manager: WorkingStateManager): WorkingStateSnapshot {
	const state = manager.getState()
	return {
		task: state.task,
		plan: [...state.plan],
		files: [...state.files.values()],
		decisions: [...state.decisions],
		failures: [...state.failures],
		discoveries: [...state.discoveries],
		environment: [...state.environment],
		toolResults: [...state.toolResults],
		userRequirements: [...state.userRequirements],
		assistantNotes: [...state.assistantNotes],
		evicted: { ...state.evicted },
	}
}

/**
 * Rebuild a manager from a snapshot.
 *
 * Restores the state DIRECTLY rather than replaying the extractors over
 * the restored messages. Re-extraction would be both lossy — the messages
 * the first pass compacted away are gone, so there is nothing left to
 * extract them from — and non-idempotent, producing a state that differs
 * from the one that was summarized.
 */
export function restoreWorkingState(
	snapshot: WorkingStateSnapshot,
	config: CompactionConfig,
): WorkingStateManager {
	const manager = new WorkingStateManager(config)
	const state: WorkingState = {
		task: snapshot.task,
		plan: [...snapshot.plan],
		files: new Map(snapshot.files.map((f) => [f.path, f])),
		decisions: [...snapshot.decisions],
		failures: [...snapshot.failures],
		discoveries: [...snapshot.discoveries],
		environment: [...snapshot.environment],
		toolResults: [...snapshot.toolResults],
		userRequirements: [...snapshot.userRequirements],
		assistantNotes: [...snapshot.assistantNotes],
		evicted: { ...snapshot.evicted },
	}
	manager.replaceState(state)
	return manager
}
