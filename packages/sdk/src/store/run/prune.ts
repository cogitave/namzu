import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'

/** What choosing checkpoints to prune needs to know about each one. */
export type PrunableCheckpoint = Pick<IterationCheckpoint, 'id' | 'createdAt' | 'pending'>

/**
 * The checkpoints to delete so that `keepLast` newer ones remain.
 *
 * Growth control, and growth control stops at a park. A checkpoint with an
 * unresolved `pending` is the durable fact that a human was asked something:
 * it is what `findPendingCheckpoint` serves to an approval queue and what
 * `listExpiredParks` enumerates for a sweep. Collecting one deletes the only
 * record of a question somebody may be in the middle of answering.
 *
 * So the candidates are the oldest `all.length - keepLast`, which keeps the
 * newest `keepLast` — the run's resume point — out of reach, and a park among
 * them is skipped rather than counted. Expired parks are skipped too: the
 * host's sweep resolves those by running out of time, not by deletion.
 *
 * One rule, shared by `CheckpointManager.prune` and the disk store's own
 * `pruneCheckpoints`, so the two cannot disagree about what is kept.
 */
export function selectCheckpointsToPrune(
	checkpoints: readonly PrunableCheckpoint[],
	keepLast: number,
): CheckpointId[] {
	if (checkpoints.length <= keepLast) return []
	return [...checkpoints]
		.sort((a, b) => a.createdAt - b.createdAt)
		.slice(0, checkpoints.length - keepLast)
		.filter((cp) => !(cp.pending && cp.pending.resolvedAt === undefined))
		.map((cp) => cp.id)
}
