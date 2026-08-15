import { describe, expect, it } from 'vitest'
import { ThreadClosedError, ThreadNotEmptyError } from '../../../session/errors.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { AgentId, TenantId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ThreadId } from '../../../types/session/ids.js'
import { TopicManager } from '../lifecycle.js'

const MISSING_TOPIC_ID = 'top_missing' as ThreadId

const tenantA = 'tnt_alpha' as TenantId
const tenantB = 'tnt_beta' as TenantId

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId }
}

async function harness(tenantId: TenantId = tenantA) {
	const topicStore = new InMemoryTopicStore()
	const sessionStore = new InMemorySessionStore()
	const project = await sessionStore.createProject({ tenantId, name: 'p1' }, tenantId)
	const topic = await topicStore.createTopic({ projectId: project.id, title: 't' }, tenantId)
	const manager = new TopicManager({ topicStore, sessionStore })
	return { topicStore, sessionStore, project, topic, manager }
}

describe('TopicManager', () => {
	describe('requireOpen', () => {
		it('returns the topic when open', async () => {
			const { topic, manager } = await harness()
			await expect(manager.requireOpen(topic.id, tenantA)).resolves.toMatchObject({
				id: topic.id,
				status: 'open',
			})
		})

		it('throws ThreadClosedError when archived', async () => {
			const { topic, manager, topicStore } = await harness()
			await topicStore.updateTopic({ ...topic, status: 'archived' }, tenantA)
			await expect(manager.requireOpen(topic.id, tenantA)).rejects.toBeInstanceOf(ThreadClosedError)
		})

		it('throws when the topic does not exist', async () => {
			const { manager } = await harness()
			await expect(manager.requireOpen(MISSING_TOPIC_ID, tenantA)).rejects.toThrow(/not found/)
		})
	})

	describe('archive', () => {
		it('flips status to archived and bumps ownerVersion', async () => {
			const { topic, manager } = await harness()
			const archived = await manager.archive(topic.id, tenantA)
			expect(archived.status).toBe('archived')
			expect(archived.ownerVersion).toBe(topic.ownerVersion + 1)
		})

		it('is idempotent on an already-archived topic (no store write)', async () => {
			const { topic, manager, topicStore } = await harness()
			await topicStore.updateTopic({ ...topic, status: 'archived' }, tenantA)
			const before = await topicStore.getTopic(topic.id, tenantA)

			const result = await manager.archive(topic.id, tenantA)
			expect(result.status).toBe('archived')
			// Re-archival must NOT advance ownerVersion — the store would have
			// rejected a second updateTopic as stale anyway; we assert the
			// short-circuit path held instead.
			expect(result.ownerVersion).toBe(before?.ownerVersion)
		})

		it('throws when the topic does not exist', async () => {
			const { manager } = await harness()
			await expect(manager.archive(MISSING_TOPIC_ID, tenantA)).rejects.toThrow(/not found/)
		})

		it('rejects with ThreadNotEmptyError when a session is active', async () => {
			const { topic, project, manager, sessionStore } = await harness()
			const session = await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...session, status: 'active' }, tenantA)

			await expect(manager.archive(topic.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					threadId: topic.id,
					tenantId: tenantA,
					op: 'archive',
					totalBlockingSessions: 1,
					blockingSessions: [{ sessionId: session.id, status: 'active' }],
				},
			})
		})

		it('defensive re-check: already-archived topic with a smuggled active session still rejects', async () => {
			// Flip the topic to archived directly (bypassing manager.archive so
			// no check runs), then attach an active session via direct store
			// mutation. A subsequent manager.archive() must surface the offender
			// as ThreadNotEmptyError, not short-circuit as "already archived".
			const { topic, project, manager, sessionStore, topicStore } = await harness()
			await topicStore.updateTopic({ ...topic, status: 'archived' }, tenantA)
			const smuggled = await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...smuggled, status: 'active' }, tenantA)

			await expect(manager.archive(topic.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					op: 'archive',
					totalBlockingSessions: 1,
					blockingSessions: [{ sessionId: smuggled.id, status: 'active' }],
				},
			})
		})

		it.each(['locked', 'awaiting_hitl', 'awaiting_merge'] as const)(
			'rejects when a session is %s',
			async (status) => {
				const { topic, project, manager, sessionStore } = await harness()
				const session = await sessionStore.createSession(
					{
						topicId: topic.id,
						projectId: project.id,
						currentActor: userActor(tenantA),
					},
					tenantA,
				)
				await sessionStore.updateSession({ ...session, status }, tenantA)

				await expect(manager.archive(topic.id, tenantA)).rejects.toBeInstanceOf(ThreadNotEmptyError)
			},
		)

		it('allows archival when every session is quiescent (idle / failed / archived)', async () => {
			const { topic, project, manager, sessionStore } = await harness()
			// `createSession` defaults to `idle`; force the others via updateSession.
			await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			const sFailed = await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: agentActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...sFailed, status: 'failed' }, tenantA)

			const archived = await manager.archive(topic.id, tenantA)
			expect(archived.status).toBe('archived')
		})

		it('ignores sessions attached to a sibling topic', async () => {
			const { topic, project, manager, sessionStore, topicStore } = await harness()
			const other = await topicStore.createTopic({ projectId: project.id, title: 'other' }, tenantA)
			// Active session under the OTHER topic must not block archival of
			// `topic`.
			const otherSession = await sessionStore.createSession(
				{
					topicId: other.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...otherSession, status: 'active' }, tenantA)

			await expect(manager.archive(topic.id, tenantA)).resolves.toMatchObject({
				status: 'archived',
			})
		})

		it('does not leak cross-tenant sessions into the precondition', async () => {
			// Shared stores across tenants (production shape). A session with
			// the same topicId string under tenantB must not block archival
			// of tenantA's topic.
			const topicStore = new InMemoryTopicStore()
			const sessionStore = new InMemorySessionStore()
			const manager = new TopicManager({ topicStore, sessionStore })

			const pA = await sessionStore.createProject({ tenantId: tenantA, name: 'pa' }, tenantA)
			const pB = await sessionStore.createProject({ tenantId: tenantB, name: 'pb' }, tenantB)
			const tA = await topicStore.createTopic({ projectId: pA.id, title: 'ta' }, tenantA)

			// Cross-tenant session with the same topicId string as tA.
			const bSession = await sessionStore.createSession(
				{ topicId: tA.id, projectId: pB.id, currentActor: userActor(tenantB) },
				tenantB,
			)
			await sessionStore.updateSession({ ...bSession, status: 'active' }, tenantB)

			await expect(manager.archive(tA.id, tenantA)).resolves.toMatchObject({
				status: 'archived',
			})
		})
	})

	describe('delete', () => {
		it('deletes an empty topic', async () => {
			const { topic, manager, topicStore } = await harness()
			await manager.delete(topic.id, tenantA)
			expect(await topicStore.getTopic(topic.id, tenantA)).toBeNull()
		})

		it('rejects with ThreadNotEmptyError when any session references the topic', async () => {
			const { topic, project, manager, sessionStore } = await harness()
			const session = await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			// Idle — allowed under archive, still blocks delete.
			await expect(manager.delete(topic.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					threadId: topic.id,
					tenantId: tenantA,
					op: 'delete',
					totalBlockingSessions: 1,
					blockingSessions: [{ sessionId: session.id, status: 'idle' }],
				},
			})
		})

		it('detects orphaned sessions referencing a missing topic', async () => {
			// Topic record is destroyed via the store directly, but a session
			// still carries its topicId. Manager.delete must reject rather
			// than silently succeed on the "topic is already gone" short-cut
			// (the session scan runs unconditionally).
			const { topic, project, manager, sessionStore, topicStore } = await harness()
			const orphan = await sessionStore.createSession(
				{
					topicId: topic.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await topicStore.deleteTopic(topic.id, tenantA)

			await expect(manager.delete(topic.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					op: 'delete',
					blockingSessions: [{ sessionId: orphan.id, status: 'idle' }],
				},
			})
		})

		it('is idempotent for an absent topic with no orphans', async () => {
			const { manager } = await harness()
			await expect(manager.delete(MISSING_TOPIC_ID, tenantA)).resolves.toBeUndefined()
		})
	})
})
