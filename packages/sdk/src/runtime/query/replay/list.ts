import { RunDiskStore } from '../../../store/run/disk.js'
import type { RunId } from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { CheckpointListEntry } from '../../../types/run/replay.js'
import type { Logger } from '../../../utils/logger.js'
import { toCheckpointListEntry } from '../checkpoint.js'

export interface ListCheckpointsInput {
	/** Directory that contains `<runId>/` for the target run. */
	baseDir: string
	/** Run whose checkpoints should be listed. */
	runId: RunId
	logger?: Logger
	/**
	 * Optional store override (host-injected, e.g. Postgres). When set,
	 * `scope` is required — a scope-keyed backend cannot be addressed by
	 * `baseDir` — and `baseDir` is ignored. Absent ⇒ the disk layout under
	 * `baseDir` is read, exactly as before.
	 */
	checkpointStore?: CheckpointStore
	/** Run scope for `checkpointStore`. Required when it is set. */
	scope?: CheckpointRunScope
}

/**
 * Read-only listing of a run's checkpoints for use with {@link
 * import('./prepare.js').prepareReplayState}. Returns the public
 * {@link CheckpointListEntry} projection — just enough for a caller to
 * pick a fork point — not the full `IterationCheckpoint` payload.
 *
 * Entries are returned in the order the underlying store returns them
 * (stores sort by `createdAt` ascending). Callers that want a
 * specific order should sort client-side.
 *
 * See ses_005-deterministic-replay/design.md §3.1.
 */
export async function listCheckpoints(input: ListCheckpointsInput): Promise<CheckpointListEntry[]> {
	const checkpoints = await listRawCheckpoints(input)
	return checkpoints.map(toCheckpointListEntry)
}

async function listRawCheckpoints(input: ListCheckpointsInput) {
	if (input.checkpointStore) {
		return input.checkpointStore.listCheckpoints(requireScope(input.scope, 'listCheckpoints'))
	}
	const store = new RunDiskStore({ baseDir: input.baseDir, logger: input.logger })
	await store.initRun(input.runId)
	return store.listCheckpoints()
}

/**
 * Guard shared by the replay entry points: an injected {@link
 * CheckpointStore} is scope-keyed, so the caller must say which run —
 * across the full five-layer attribution — it is asking about.
 */
export function requireScope(
	scope: CheckpointRunScope | undefined,
	caller: string,
): CheckpointRunScope {
	if (!scope) {
		throw new Error(
			`${caller}: \`checkpointStore\` was provided without \`scope\` — an injected store is keyed by tenantId/projectId/sessionId/runId, not by baseDir.`,
		)
	}
	return scope
}
