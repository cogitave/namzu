/**
 * TopicStore — canonical persistence contract for the Topic layer
 * (Project → **Topic** → Session → SubSession → Run).
 *
 * Topics are pure containers (Phase 0 decision B.1). They have no own
 * message stream and no fan-in `deriveStatus()` — status is owner-managed
 * (`'open' | 'archived'`). Every accessor takes explicit {@link TenantId};
 * cross-tenant access rejects with `TenantIsolationError` (Convention #17).
 *
 * Read accessors return `null` when the resource does not exist for the
 * supplied tenant (deny-by-default surface). Callers branch on missing
 * explicitly — no fallback substitution.
 *
 * `deleteTopic` is intentionally a dumb record-delete at this layer:
 * it does NOT walk session ownership. The "reject when sessions attached"
 * precondition lives in {@link import('../../manager/topic/lifecycle.js').TopicManager}
 * where both stores are in scope. Keeping TopicStore free of cross-store
 * awareness preserves the single-boundary ownership boundary that Phase 2
 * has just introduced for this layer (Convention #0).
 *
 * NZ-TOPIC-01 renamed this from `ThreadStore`/`createThread` etc, leaving
 * the `threadId` parameter below alone — it is the FK field a Session
 * carries to its owning Topic, and that rename had its own data-migration
 * story (persisted `session.json` records already on disk, see
 * `store/session/disk.ts`). NZ-TOPIC-03 lands it: the parameter below is
 * `topicId` now, matching the `Session.topicId` it identifies.
 */

import type { Topic } from '../../types/topic/entity.js'
import type { TenantId } from '../ids/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'

/**
 * Params for {@link TopicStore.createTopic}. The store owns id generation,
 * `ownerVersion` initialization (0 at create), and timestamps.
 */
export interface CreateTopicParams {
	projectId: ProjectId
	/**
	 * User-facing display label. Not unique within the project — see
	 * {@link Topic} JSDoc. Empty strings are permitted; callers that require
	 * a label should validate at the API layer.
	 */
	title: string
}

/**
 * Canonical persistence contract for the Topic layer. Every accessor takes
 * explicit `tenantId`; cross-tenant reads/writes reject with
 * `TenantIsolationError` (`session/errors.ts`, Convention #17).
 */
export interface TopicStore {
	/**
	 * Persist a new Topic under the given project. Returns the minted
	 * {@link Topic} with `ownerVersion: 0` and freshly-generated
	 * {@link import('../ids/index.js').TopicId}. Callers must ensure the parent
	 * project exists and belongs to the same tenant — the store does not
	 * validate project ownership (that is a cross-store precondition owned by
	 * the manager).
	 */
	createTopic(params: CreateTopicParams, tenantId: TenantId): Promise<Topic>

	/**
	 * Read a Topic by id. Returns `null` when absent. Cross-tenant reads
	 * reject with `TenantIsolationError`.
	 */
	getTopic(topicId: ThreadId, tenantId: TenantId): Promise<Topic | null>

	/**
	 * Persist a mutation to a Topic record. CAS on `ownerVersion`: if the
	 * supplied `topic.ownerVersion` does not match the persisted version,
	 * rejects with {@link import('../../session/errors.js').StaleThreadError}
	 * (class name unchanged this release). On success the write commits with
	 * `ownerVersion + 1` and a refreshed `updatedAt`.
	 *
	 * Archival transition (`status: 'open' → 'archived'`) shares this path;
	 * the caller is responsible for verifying that no non-terminal Sessions
	 * are attached before flipping (see TopicManager.archive).
	 */
	updateTopic(topic: Topic, tenantId: TenantId): Promise<void>

	/**
	 * Hard-delete a Topic record. Idempotent — absent topics succeed as a
	 * no-op. Rejects with `TenantIsolationError` on cross-tenant access.
	 *
	 * **Does NOT cascade to child Sessions** — the caller (typically
	 * TopicManager) enforces the precondition that no Sessions reference
	 * this topic. Convention #5: deny-by-default, no implicit cascade.
	 */
	deleteTopic(topicId: ThreadId, tenantId: TenantId): Promise<void>

	/**
	 * List all Topics under a project for the given tenant, ordered by
	 * `createdAt` ascending. Returns an empty array when none exist.
	 * Cross-tenant reads reject with `TenantIsolationError`.
	 *
	 * The return shape is a concrete snapshot — callers that mutate the
	 * result array do not affect store state.
	 */
	listTopics(projectId: ProjectId, tenantId: TenantId): Promise<readonly Topic[]>
}
