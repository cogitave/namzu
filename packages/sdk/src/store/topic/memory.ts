/**
 * InMemoryTopicStore — reference in-memory implementation of
 * {@link TopicStore}.
 *
 * Mirrors the write-time CAS contract of the disk store: every
 * `updateTopic` compares the supplied `ownerVersion` against the persisted
 * copy and rejects with `StaleThreadError` on mismatch (class name
 * unchanged this release — see NZ-TOPIC-01 risks). Convention #17:
 * cross-tenant access throws `TenantIsolationError` with no fallback.
 *
 * NZ-TOPIC-01 renamed this from `InMemoryThreadStore` (moved from
 * `store/thread/memory.ts`). `InMemoryThreadStore` keeps working, unaliased
 * — `public-runtime.ts` re-exports it as a literal identity binding to this
 * class, so `instanceof`/`===` both still hold for a caller who has not
 * migrated.
 */

import { StaleThreadError, TenantIsolationError } from '../../session/errors.js'
import type { TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { Topic } from '../../types/topic/entity.js'
import type { CreateTopicParams, TopicStore } from '../../types/topic/store.js'
import { generateTopicId } from '../../utils/id.js'

interface TopicRecord {
	tenantId: TenantId
	topic: Topic
}

export class InMemoryTopicStore implements TopicStore {
	private readonly topics = new Map<ThreadId, TopicRecord>()

	async createTopic(params: CreateTopicParams, tenantId: TenantId): Promise<Topic> {
		const now = new Date()
		const topic: Topic = {
			id: generateTopicId(),
			projectId: params.projectId,
			tenantId,
			title: params.title,
			status: 'open',
			ownerVersion: 0,
			createdAt: now,
			updatedAt: now,
		}
		this.topics.set(topic.id, { tenantId, topic })
		return topic
	}

	async getTopic(threadId: ThreadId, tenantId: TenantId): Promise<Topic | null> {
		const record = this.topics.get(threadId)
		if (!record) return null
		this.assertTenant(record.tenantId, tenantId, `topic(${threadId})`)
		return record.topic
	}

	async updateTopic(topic: Topic, tenantId: TenantId): Promise<void> {
		if (topic.tenantId !== tenantId) {
			throw new TenantIsolationError({
				requested: tenantId,
				resource: `topic(${topic.id}) payload`,
			})
		}
		const existing = this.topics.get(topic.id)
		if (!existing) {
			throw new Error(`Topic ${topic.id} not found`)
		}
		this.assertTenant(existing.tenantId, tenantId, `topic(${topic.id})`)

		// CAS on ownerVersion — supplied version must match persisted exactly.
		// Any drift means another writer already advanced the record; the caller
		// must re-read + re-apply + retry.
		if (topic.ownerVersion !== existing.topic.ownerVersion) {
			throw new StaleThreadError({
				threadId: topic.id,
				expectedVersion: topic.ownerVersion,
				actualVersion: existing.topic.ownerVersion,
			})
		}

		const updated: Topic = {
			...topic,
			ownerVersion: existing.topic.ownerVersion + 1,
			updatedAt: new Date(),
		}
		this.topics.set(topic.id, { tenantId, topic: updated })
	}

	async deleteTopic(threadId: ThreadId, tenantId: TenantId): Promise<void> {
		const record = this.topics.get(threadId)
		if (!record) return // Idempotent: missing = no-op.
		this.assertTenant(record.tenantId, tenantId, `topic(${threadId})`)
		this.topics.delete(threadId)
	}

	async listTopics(projectId: ProjectId, tenantId: TenantId): Promise<readonly Topic[]> {
		const matches: Topic[] = []
		for (const { tenantId: ownerTenant, topic } of this.topics.values()) {
			if (ownerTenant !== tenantId) continue
			if (topic.projectId !== projectId) continue
			matches.push(topic)
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
