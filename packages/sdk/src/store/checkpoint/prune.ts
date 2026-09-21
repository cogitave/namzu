import type { CheckpointId } from '../../types/ids/index.js'
import type { Checkpoint } from '../../types/session/checkpoint.js'

/** What choosing checkpoints to prune needs to know about each one. */
export type PrunableSessionCheckpoint = Pick<Checkpoint, 'checkpointId' | 'createdAt'>

/**
 * The checkpoints to delete so that `keepLast` newer ones remain.
 *
 * Salvaged from the run-era `selectCheckpointsToPrune`: the candidates are the
 * oldest `all.length - keepLast`, which keeps the newest `keepLast` (the
 * turn's resume point) out of reach, and a protected checkpoint among them is
 * skipped rather than counted.
 *
 * A checkpoint is protected when an open decision references it. The run-era
 * document carried its own `pending` park; a session checkpoint carries none,
 * because the question lives in the log as a `decision_requested` record with
 * no `decision_resolved` or `decision_expired` after it. Deleting the
 * checkpoint such a record names would leave a question somebody may be in
 * the middle of answering with nothing to resume from. An expired decision is
 * closed by its own record, so it protects nothing.
 *
 * Order is `createdAt`, then `checkpointId`: ids are UUIDv7, so the tiebreak
 * is also chronological within one millisecond, and the order is total.
 *
 * @throws RangeError when `keepLast` is not a nonnegative safe integer.
 */
export function selectSessionCheckpointsToPrune(
	checkpoints: readonly PrunableSessionCheckpoint[],
	keepLast: number,
	protectedIds: ReadonlySet<CheckpointId> = new Set(),
): CheckpointId[] {
	if (!Number.isSafeInteger(keepLast) || keepLast < 0) {
		throw new RangeError(`keepLast must be a nonnegative integer, got ${String(keepLast)}`)
	}
	if (checkpoints.length <= keepLast) return []
	return [...checkpoints]
		.sort(compareCheckpoints)
		.slice(0, checkpoints.length - keepLast)
		.filter((checkpoint) => !protectedIds.has(checkpoint.checkpointId))
		.map((checkpoint) => checkpoint.checkpointId)
}

/** Oldest first: `createdAt`, then `checkpointId`. Shared by every store's `list`. */
export function compareCheckpoints(
	left: PrunableSessionCheckpoint,
	right: PrunableSessionCheckpoint,
): number {
	const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt)
	if (byTime !== 0) return byTime
	return left.checkpointId < right.checkpointId
		? -1
		: left.checkpointId > right.checkpointId
			? 1
			: 0
}
