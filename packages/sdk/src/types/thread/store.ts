/**
 * ThreadStore — canonical persistence contract for the Thread topic layer
 * (Project → **Thread** → Session → SubSession → Run).
 *
 * Threads are pure containers (Phase 0 decision B.1). They have no own
 * message stream and no fan-in `deriveStatus()` — status is owner-managed
 * (`'open' | 'archived'`). Every accessor takes explicit {@link TenantId};
 * cross-tenant access rejects with `TenantIsolationError` (Convention #17).
 *
 * Read accessors return `null` when the resource does not exist for the
 * supplied tenant (deny-by-default surface). Callers branch on missing
 * explicitly — no fallback substitution.
 *
 * `deleteThread` is intentionally a dumb record-delete at this layer:
 * it does NOT walk session ownership. The "reject when sessions attached"
 * precondition lives in {@link import('../../manager/thread/lifecycle.js').ThreadManager}
 * where both stores are in scope. Keeping ThreadStore free of cross-store
 * awareness preserves the single-boundary ownership boundary that Phase 2
 * has just introduced for this layer (Convention #0).
 */

import type { Thread } from '../../types/thread/entity.js'
import type { TenantId } from '../ids/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'

/**
 * Params for {@link ThreadStore.createThread}. The store owns id generation,
 * `ownerVersion` initialization (0 at create), and timestamps.
 */
export interface CreateThreadParams {
	projectId: ProjectId
	/**
	 * User-facing display label. Not unique within the project — see
	 * {@link Thread} JSDoc. Empty strings are permitted; callers that require
	 * a label should validate at the API layer.
	 */
	title: string
}

/**
 * Canonical persistence contract for the Thread layer. Every accessor takes
 * explicit `tenantId`; cross-tenant reads/writes reject with
 * `TenantIsolationError` (`session/errors.ts`, Convention #17).
 */
export interface ThreadStore {
	/**
	 * Persist a new Thread under the given project. Returns the minted
	 * {@link Thread} with `ownerVersion: 0` and freshly-generated
	 * {@link ThreadId}. Callers must ensure the parent project exists and
	 * belongs to the same tenant — the store does not validate project
	 * ownership (that is a cross-store precondition owned by the manager).
	 */
	createThread(params: CreateThreadParams, tenantId: TenantId): Promise<Thread>

	/**
	 * Read a Thread by id. Returns `null` when absent. Cross-tenant reads
	 * reject with `TenantIsolationError`.
	 */
	getThread(threadId: ThreadId, tenantId: TenantId): Promise<Thread | null>

	/**
	 * Persist a mutation to a Thread record. CAS on `ownerVersion`: if the
	 * supplied `thread.ownerVersion` does not match the persisted version,
	 * rejects with `StaleThreadError`. On success the write commits with
	 * `ownerVersion + 1` and a refreshed `updatedAt`.
	 *
	 * Archival transition (`status: 'open' → 'archived'`) shares this path;
	 * the caller is responsible for verifying that no non-terminal Sessions
	 * are attached before flipping (see ThreadManager.archiveThread).
	 */
	updateThread(thread: Thread, tenantId: TenantId): Promise<void>

	/**
	 * Hard-delete a Thread record. Idempotent — absent threads succeed as a
	 * no-op. Rejects with `TenantIsolationError` on cross-tenant access.
	 *
	 * **Does NOT cascade to child Sessions** — the caller (typically
	 * ThreadManager) enforces the precondition that no Sessions reference
	 * this thread. Convention #5: deny-by-default, no implicit cascade.
	 */
	deleteThread(threadId: ThreadId, tenantId: TenantId): Promise<void>

	/**
	 * List all Threads under a project for the given tenant, ordered by
	 * `createdAt` ascending. Returns an empty array when none exist.
	 * Cross-tenant reads reject with `TenantIsolationError`.
	 *
	 * The return shape is a concrete snapshot — callers that mutate the
	 * result array do not affect store state.
	 */
	listThreads(projectId: ProjectId, tenantId: TenantId): Promise<readonly Thread[]>
}
