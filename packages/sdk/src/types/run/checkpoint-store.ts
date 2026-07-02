/**
 * CheckpointStore — persistence contract for iteration checkpoints.
 *
 * Mirrors the {@link import('../session/store.js').SessionStore} precedent:
 * a narrow interface the kernel consumes, with the built-in disk layout as
 * the default implementation and host-injected backends (e.g. Postgres) as
 * drop-in replacements. Every accessor takes an explicit
 * {@link CheckpointRunScope} so a shared backend can key rows by the full
 * five-layer attribution (Convention #17) instead of a filesystem path.
 */

import type { CheckpointId, IterationCheckpoint } from '../hitl/index.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { ProjectId } from '../session/ids.js'

/**
 * Identifies the run whose checkpoints are being addressed.
 *
 * The full Tenant → Project → Session → Run scope is required so shared
 * backends can enforce isolation; the built-in
 * {@link import('../../store/run/checkpoint-disk.js').DiskCheckpointStore}
 * is path-addressed (its `baseDir` already encodes project/session) and
 * only consults `runId`/`parentRunId` for directory layout.
 */
export interface CheckpointRunScope {
	/** Isolation boundary (Convention #17). */
	tenantId: TenantId
	/** Long-lived goal scope the run belongs to. */
	projectId: ProjectId
	/** Session the run is attributed to. */
	sessionId: SessionId
	/** Run whose checkpoints are addressed. */
	runId: RunId
	/**
	 * Present for sub-runs. Hierarchical stores may use it for layout (the
	 * disk store nests sub-run directories under
	 * `<parentRunId>/children/<runId>`); flat stores can ignore it.
	 */
	parentRunId?: RunId
}

/**
 * Persistence contract consumed by
 * {@link import('../../runtime/query/checkpoint.js').CheckpointManager} and
 * the replay entry points (`listCheckpoints` / `prepareReplayState`).
 *
 * Read accessors return `null` / an empty array when nothing exists for the
 * supplied scope — callers branch on missing explicitly, never on a thrown
 * not-found error. `deleteCheckpoint` is idempotent: deleting an absent
 * checkpoint succeeds as a no-op (mirrors the disk store's ENOENT
 * swallowing).
 */
export interface CheckpointStore {
	/** Persist one checkpoint. Overwrites an existing checkpoint with the same id. */
	writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void>

	/** Load a single checkpoint by id. Returns `null` when it does not exist. */
	readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null>

	/**
	 * All checkpoints for the run, sorted by `createdAt` ascending (the
	 * ordering the disk store guarantees and `CheckpointManager.prune`
	 * relies on for oldest-first deletion).
	 */
	listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]>

	/** Delete a checkpoint by id. Absent checkpoints succeed as a no-op. */
	deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void>
}
