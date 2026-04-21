import { describe, expect, it } from 'vitest'
import { ThreadClosedError, ThreadNotEmptyError } from '../../../session/errors.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { AgentId, TenantId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ThreadId } from '../../../types/session/ids.js'
import { ThreadManager } from '../lifecycle.js'

const MISSING_THREAD_ID = 'thd_missing' as ThreadId

const tenantA = 'tnt_alpha' as TenantId
const tenantB = 'tnt_beta' as TenantId

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId }
}

async function harness(tenantId: TenantId = tenantA) {
	const threadStore = new InMemoryThreadStore()
	const sessionStore = new InMemorySessionStore()
	const project = await sessionStore.createProject({ tenantId, name: 'p1' }, tenantId)
	const thread = await threadStore.createThread({ projectId: project.id, title: 't' }, tenantId)
	const manager = new ThreadManager({ threadStore, sessionStore })
	return { threadStore, sessionStore, project, thread, manager }
}

describe('ThreadManager', () => {
	describe('requireOpen', () => {
		it('returns the thread when open', async () => {
			const { thread, manager } = await harness()
			await expect(manager.requireOpen(thread.id, tenantA)).resolves.toMatchObject({
				id: thread.id,
				status: 'open',
			})
		})

		it('throws ThreadClosedError when archived', async () => {
			const { thread, manager, threadStore } = await harness()
			await threadStore.updateThread({ ...thread, status: 'archived' }, tenantA)
			await expect(manager.requireOpen(thread.id, tenantA)).rejects.toBeInstanceOf(
				ThreadClosedError,
			)
		})

		it('throws when the thread does not exist', async () => {
			const { manager } = await harness()
			await expect(manager.requireOpen(MISSING_THREAD_ID, tenantA)).rejects.toThrow(/not found/)
		})
	})

	describe('archive', () => {
		it('flips status to archived and bumps ownerVersion', async () => {
			const { thread, manager } = await harness()
			const archived = await manager.archive(thread.id, tenantA)
			expect(archived.status).toBe('archived')
			expect(archived.ownerVersion).toBe(thread.ownerVersion + 1)
		})

		it('is idempotent on an already-archived thread (no store write)', async () => {
			const { thread, manager, threadStore } = await harness()
			await threadStore.updateThread({ ...thread, status: 'archived' }, tenantA)
			const before = await threadStore.getThread(thread.id, tenantA)

			const result = await manager.archive(thread.id, tenantA)
			expect(result.status).toBe('archived')
			// Re-archival must NOT advance ownerVersion — the store would have
			// rejected a second updateThread as stale anyway; we assert the
			// short-circuit path held instead.
			expect(result.ownerVersion).toBe(before?.ownerVersion)
		})

		it('throws when the thread does not exist', async () => {
			const { manager } = await harness()
			await expect(manager.archive(MISSING_THREAD_ID, tenantA)).rejects.toThrow(/not found/)
		})

		it('rejects with ThreadNotEmptyError when a session is active', async () => {
			const { thread, project, manager, sessionStore } = await harness()
			const session = await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...session, status: 'active' }, tenantA)

			await expect(manager.archive(thread.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					threadId: thread.id,
					tenantId: tenantA,
					op: 'archive',
					totalBlockingSessions: 1,
					blockingSessions: [{ sessionId: session.id, status: 'active' }],
				},
			})
		})

		it('defensive re-check: already-archived thread with a smuggled active session still rejects', async () => {
			// Flip the thread to archived directly (bypassing manager.archive so
			// no check runs), then attach an active session via direct store
			// mutation. A subsequent manager.archive() must surface the offender
			// as ThreadNotEmptyError, not short-circuit as "already archived".
			const { thread, project, manager, sessionStore, threadStore } = await harness()
			await threadStore.updateThread({ ...thread, status: 'archived' }, tenantA)
			const smuggled = await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...smuggled, status: 'active' }, tenantA)

			await expect(manager.archive(thread.id, tenantA)).rejects.toMatchObject({
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
				const { thread, project, manager, sessionStore } = await harness()
				const session = await sessionStore.createSession(
					{
						threadId: thread.id,
						projectId: project.id,
						currentActor: userActor(tenantA),
					},
					tenantA,
				)
				await sessionStore.updateSession({ ...session, status }, tenantA)

				await expect(manager.archive(thread.id, tenantA)).rejects.toBeInstanceOf(
					ThreadNotEmptyError,
				)
			},
		)

		it('allows archival when every session is quiescent (idle / failed / archived)', async () => {
			const { thread, project, manager, sessionStore } = await harness()
			// `createSession` defaults to `idle`; force the others via updateSession.
			await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			const sFailed = await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: agentActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...sFailed, status: 'failed' }, tenantA)

			const archived = await manager.archive(thread.id, tenantA)
			expect(archived.status).toBe('archived')
		})

		it('ignores sessions attached to a sibling thread', async () => {
			const { thread, project, manager, sessionStore, threadStore } = await harness()
			const other = await threadStore.createThread(
				{ projectId: project.id, title: 'other' },
				tenantA,
			)
			// Active session under the OTHER thread must not block archival of
			// `thread`.
			const otherSession = await sessionStore.createSession(
				{
					threadId: other.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await sessionStore.updateSession({ ...otherSession, status: 'active' }, tenantA)

			await expect(manager.archive(thread.id, tenantA)).resolves.toMatchObject({
				status: 'archived',
			})
		})

		it('does not leak cross-tenant sessions into the precondition', async () => {
			// Shared stores across tenants (production shape). A session with
			// the same threadId string under tenantB must not block archival
			// of tenantA's thread.
			const threadStore = new InMemoryThreadStore()
			const sessionStore = new InMemorySessionStore()
			const manager = new ThreadManager({ threadStore, sessionStore })

			const pA = await sessionStore.createProject({ tenantId: tenantA, name: 'pa' }, tenantA)
			const pB = await sessionStore.createProject({ tenantId: tenantB, name: 'pb' }, tenantB)
			const tA = await threadStore.createThread({ projectId: pA.id, title: 'ta' }, tenantA)

			// Cross-tenant session with the same threadId string as tA.
			const bSession = await sessionStore.createSession(
				{ threadId: tA.id, projectId: pB.id, currentActor: userActor(tenantB) },
				tenantB,
			)
			await sessionStore.updateSession({ ...bSession, status: 'active' }, tenantB)

			await expect(manager.archive(tA.id, tenantA)).resolves.toMatchObject({
				status: 'archived',
			})
		})
	})

	describe('delete', () => {
		it('deletes an empty thread', async () => {
			const { thread, manager, threadStore } = await harness()
			await manager.delete(thread.id, tenantA)
			expect(await threadStore.getThread(thread.id, tenantA)).toBeNull()
		})

		it('rejects with ThreadNotEmptyError when any session references the thread', async () => {
			const { thread, project, manager, sessionStore } = await harness()
			const session = await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			// Idle — allowed under archive, still blocks delete.
			await expect(manager.delete(thread.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					threadId: thread.id,
					tenantId: tenantA,
					op: 'delete',
					totalBlockingSessions: 1,
					blockingSessions: [{ sessionId: session.id, status: 'idle' }],
				},
			})
		})

		it('detects orphaned sessions referencing a missing thread', async () => {
			// Thread record is destroyed via the store directly, but a session
			// still carries its threadId. Manager.delete must reject rather
			// than silently succeed on the "thread is already gone" short-cut
			// (the session scan runs unconditionally).
			const { thread, project, manager, sessionStore, threadStore } = await harness()
			const orphan = await sessionStore.createSession(
				{
					threadId: thread.id,
					projectId: project.id,
					currentActor: userActor(tenantA),
				},
				tenantA,
			)
			await threadStore.deleteThread(thread.id, tenantA)

			await expect(manager.delete(thread.id, tenantA)).rejects.toMatchObject({
				name: 'ThreadNotEmptyError',
				details: {
					op: 'delete',
					blockingSessions: [{ sessionId: orphan.id, status: 'idle' }],
				},
			})
		})

		it('is idempotent for an absent thread with no orphans', async () => {
			const { manager } = await harness()
			await expect(manager.delete(MISSING_THREAD_ID, tenantA)).resolves.toBeUndefined()
		})
	})
})
