import { RunDiskStore } from '../../../store/run/disk.js'
import type { RunId } from '../../../types/ids/index.js'
import type { CheckpointListEntry } from '../../../types/run/replay.js'
import type { Logger } from '../../../utils/logger.js'
import { CheckpointManager } from '../checkpoint.js'

export interface ListCheckpointsInput {
	/** Directory that contains `<runId>/` for the target run. */
	baseDir: string
	/** Run whose checkpoints should be listed. */
	runId: RunId
	logger?: Logger
}

/**
 * Read-only listing of a run's checkpoints for use with {@link
 * import('./prepare.js').prepareReplayState}. Returns the public
 * {@link CheckpointListEntry} projection — just enough for a caller to
 * pick a fork point — not the full `IterationCheckpoint` payload.
 *
 * Entries are returned in the order the underlying store returns them
 * (disk store sorts by `createdAt` ascending). Callers that want a
 * specific order should sort client-side.
 *
 * See ses_005-deterministic-replay/design.md §3.1.
 */
export async function listCheckpoints(input: ListCheckpointsInput): Promise<CheckpointListEntry[]> {
	const store = new RunDiskStore({ baseDir: input.baseDir, logger: input.logger })
	await store.initRun(input.runId)
	const mgr = new CheckpointManager(store)
	return mgr.listEntries()
}
