import type { CheckpointScope, SessionCheckpointStore } from '../../../store/checkpoint/index.js'
import type { CheckpointListEntry } from '../../../types/session/fork.js'
import { toCheckpointListEntry } from '../checkpoint.js'

export interface ListCheckpointsInput {
	/** The store the turn's checkpoints are in. */
	readonly checkpointStore: SessionCheckpointStore
	/** The turn whose checkpoints are listed, across the full attribution. */
	readonly scope: CheckpointScope
}

/**
 * Read-only listing of a turn's checkpoints, to pick a fork point for
 * {@link import('./prepare.js').prepareForkState}. Returns the public
 * {@link CheckpointListEntry} projection, oldest first.
 */
export async function listCheckpoints(input: ListCheckpointsInput): Promise<CheckpointListEntry[]> {
	const checkpoints = await input.checkpointStore.list(input.scope)
	return checkpoints.map(toCheckpointListEntry)
}
