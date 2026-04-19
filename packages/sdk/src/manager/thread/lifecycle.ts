/**
 * ThreadManager — thin orchestrator over {@link ThreadStore}.
 *
 * Owns user-facing lifecycle operations on the Thread topic layer. Keeps the
 * kernel's spawn path (AgentManager) reading ThreadStore directly for the
 * `requireOpen` precondition, since that check is on the hot path and
 * threading a manager through is structural overhead for a one-method call.
 *
 * Archive + delete paths require session-presence checks that cross into
 * {@link import('../../types/session/store.js').SessionStore}. Those land
 * once `SessionStore.listSessions(threadId, tenantId)` exists (Phase 2 step
 * 2.5). The manager surface grows incrementally alongside its dependencies —
 * Convention #0: no speculative API.
 */

import { ThreadClosedError } from '../../session/errors.js'
import type { Thread } from '../../session/hierarchy/thread.js'
import type { TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { CreateThreadParams, ThreadStore } from '../../types/thread/store.js'

export interface ThreadManagerDeps {
	readonly threadStore: ThreadStore
}

export class ThreadManager {
	private readonly deps: ThreadManagerDeps

	constructor(deps: ThreadManagerDeps) {
		this.deps = deps
	}

	/** Persist a new Thread. Thin passthrough for uniformity at the manager surface. */
	create(params: CreateThreadParams, tenantId: TenantId): Promise<Thread> {
		return this.deps.threadStore.createThread(params, tenantId)
	}

	/** Read a Thread by id; returns `null` when absent for the tenant. */
	get(threadId: ThreadId, tenantId: TenantId): Promise<Thread | null> {
		return this.deps.threadStore.getThread(threadId, tenantId)
	}

	/**
	 * CAS update on a Thread. Propagates {@link import('../../session/errors.js').StaleThreadError}
	 * from the store on `ownerVersion` mismatch — callers re-read, re-apply,
	 * and retry.
	 */
	update(thread: Thread, tenantId: TenantId): Promise<void> {
		return this.deps.threadStore.updateThread(thread, tenantId)
	}

	/** List Threads under a Project, ordered by `createdAt` ascending. */
	list(projectId: ProjectId, tenantId: TenantId): Promise<readonly Thread[]> {
		return this.deps.threadStore.listThreads(projectId, tenantId)
	}

	/**
	 * Load a Thread and assert it is in `'open'` state. Used by the spawn path
	 * as a precondition — a SubSession cannot be created under an archived
	 * Thread. Throws on absence and on archival; returns the loaded Thread on
	 * success so callers can avoid the second round-trip.
	 *
	 * Convention #5: deny-by-default. A missing Thread is a hard error, not a
	 * silent "assume archived".
	 */
	async requireOpen(threadId: ThreadId, tenantId: TenantId): Promise<Thread> {
		const thread = await this.deps.threadStore.getThread(threadId, tenantId)
		if (!thread) {
			throw new Error(`Thread ${threadId} not found`)
		}
		if (thread.status === 'archived') {
			throw new ThreadClosedError({ threadId, op: 'require-open' })
		}
		return thread
	}
}
