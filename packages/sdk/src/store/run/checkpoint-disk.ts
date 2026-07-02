import type { CheckpointId, IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { RunStoreConfig } from '../../types/run/index.js'
import { RunDiskStore } from './disk.js'

/**
 * Disk conformance layer for {@link CheckpointStore}: adapts the existing
 * {@link RunDiskStore} checkpoint methods (which are bound to a single run
 * directory via `initRun`) to the scope-keyed store contract.
 *
 * Path-addressed: `baseDir` already encodes project/session (it is the
 * session's `runs/` directory), so only `scope.runId` / `scope.parentRunId`
 * participate in directory resolution — `tenantId`/`projectId`/`sessionId`
 * exist for backends that key by attribution instead of path.
 *
 * One `RunDiskStore` is bound (and its run directory created) per distinct
 * `runId`, then cached, so repeated checkpoint operations against the same
 * run don't re-run `initRun`.
 */
export class DiskCheckpointStore implements CheckpointStore {
	private readonly config: RunStoreConfig
	private readonly bound = new Map<RunId, Promise<RunDiskStore>>()

	constructor(config: RunStoreConfig) {
		this.config = config
	}

	private bind(scope: CheckpointRunScope): Promise<RunDiskStore> {
		const cached = this.bound.get(scope.runId)
		if (cached) return cached
		const promise = (async () => {
			const store = new RunDiskStore(this.config)
			await store.initRun(scope.runId, scope.parentRunId)
			return store
		})()
		this.bound.set(scope.runId, promise)
		// A failed bind must not poison the cache — the next call retries.
		promise.catch(() => {
			this.bound.delete(scope.runId)
		})
		return promise
	}

	async writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void> {
		const store = await this.bind(scope)
		await store.writeCheckpoint(checkpoint)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		const store = await this.bind(scope)
		return store.readCheckpoint(checkpointId)
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const store = await this.bind(scope)
		return store.listCheckpoints()
	}

	async deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		const store = await this.bind(scope)
		await store.deleteCheckpoint(checkpointId)
	}
}
