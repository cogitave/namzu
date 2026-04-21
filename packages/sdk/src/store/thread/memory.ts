/**
 * InMemoryThreadStore — reference in-memory implementation of
 * {@link ThreadStore}.
 *
 * Mirrors the write-time CAS contract of the disk store: every
 * `updateThread` compares the supplied `ownerVersion` against the persisted
 * copy and rejects with `StaleThreadError` on mismatch. Convention #17:
 * cross-tenant access throws `TenantIsolationError` with no fallback.
 */

import { StaleThreadError, TenantIsolationError } from '../../session/errors.js'
import type { TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { Thread } from '../../types/thread/entity.js'
import type { CreateThreadParams, ThreadStore } from '../../types/thread/store.js'
import { generateThreadId } from '../../utils/id.js'

interface ThreadRecord {
	tenantId: TenantId
	thread: Thread
}

export class InMemoryThreadStore implements ThreadStore {
	private readonly threads = new Map<ThreadId, ThreadRecord>()

	async createThread(params: CreateThreadParams, tenantId: TenantId): Promise<Thread> {
		const now = new Date()
		const thread: Thread = {
			id: generateThreadId(),
			projectId: params.projectId,
			tenantId,
			title: params.title,
			status: 'open',
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		}
		this.threads.set(thread.id, { tenantId, thread })
		return thread
	}

	async getThread(threadId: ThreadId, tenantId: TenantId): Promise<Thread | null> {
		const record = this.threads.get(threadId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `thread(${threadId})`)
		return record.thread
	}

	async updateThread(thread: Thread, tenantId: TenantId): Promise<void> {
		if (thread.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `thread(${thread.id}) payload`,
			})
		}
		const existing = this.threads.get(thread.id)
		if (!existing) {
			throw new Error(`Thread ${thread.id} not found`)
		}
		this.assertTenant(existing.tenantId, tenantId, `thread(${thread.id})`)

		// CAS on ownerVersion — supplied version must match persisted exactly.
		// Any drift means another writer already advanced the record; the caller
		// must re-read + re-apply + retry.
		if (thread.ownerVersion !== existing.thread.ownerVersion) {
			throw new StaleThreadError({
				threadId: thread.id,
				expectedVersion: thread.ownerVersion,
				actualVersion: existing.thread.ownerVersion,
			})
		}

		const updated: Thread = {
			...thread,
			ownerVersion: existing.thread.ownerVersion + 1,
			updatedAt: new Date(),
		}
		this.threads.set(thread.id, { tenantId, thread: updated })
	}

	async deleteThread(threadId: ThreadId, tenantId: TenantId): Promise<void> {
		const record = this.threads.get(threadId)
		if (!record) return // Idempotent: missing = no-op.
		this.assertTenant(record.tenantId, tenantId, `thread(${threadId})`)
		this.threads.delete(threadId)
	}

	async listThreads(projectId: ProjectId, tenantId: TenantId): Promise<readonly Thread[]> {
		const matches: Thread[] = []
		for (const { tenantId: ownerTenant, thread } of this.threads.values()) {
			if (ownerTenant !== tenantId) continue
			if (thread.projectId !== projectId) continue
			matches.push(thread)
		}
		matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		return matches
	}

	private assertTenant(owning: TenantId, requested: TenantId, resource: string): void {
		if (owning !== requested) {
			throw new TenantIsolationError({ requested, resource })
		}
	}
}
