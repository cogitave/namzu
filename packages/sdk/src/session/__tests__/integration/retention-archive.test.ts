/**
 * Integration — retention archive / restore round-trip wired through the
 * real stack: `InMemorySessionStore` + `DiskArchiveBackend` (pointed at
 * `tmpdir()`) + `ArchivalManager` + `GitWorktreeDriver`.
 *
 * Covers roadmap §5 invariants: §12.3 retention deny-by-default, §12.3
 * archive produces tombstone (in-slot), tombstone navigable via `drill`,
 * restore full fidelity round-trip (Phase 9 closed synthetic-id loss),
 * idempotent workspace dispose.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { InMemorySessionLog, type SessionLease } from '../../../store/session-log/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { MessageId, SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { TopicId, WorkspaceId } from '../../../types/session/ids.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { generateMessageId, generateTurnId } from '../../../utils/id.js'
import { readSessionMessages } from '../../messages.js'
import { ArchivalManager, ArchiveNotConfiguredError } from '../../retention/archive.js'
import { DiskArchiveBackend } from '../../retention/disk-backend.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import { DEFAULT_TENANT, agentActor, userActor } from './_fixtures.js'

const TEST_THREAD_ID = '4bd72c65-bcc9-475c-8d7c-27d622df04e8' as TopicId

/** Session logs by session id: the only store of a session's messages. */
const sessionLogs = new Map<SessionId, InMemorySessionLog>()

function readMessages(sessionId: SessionId, tenantId: TenantId) {
	const log = sessionLogs.get(sessionId)
	return log ? readSessionMessages(log, tenantId) : Promise.resolve([])
}

/** Record `messages` into one turn of a fresh log for `sessionId`; their record ids, in order. */
async function recordMessages(
	sessionId: SessionId,
	projectId: string,
	messages: readonly Message[],
): Promise<MessageId[]> {
	const log = new InMemorySessionLog({ sessionId })
	sessionLogs.set(sessionId, log)
	const lease = (await log.claim({ holder: 'test', ttlMs: 60_000 })) as SessionLease
	await log.append(lease, {
		type: 'session_started',
		projectId,
		tenantId: DEFAULT_TENANT,
		topicId: TEST_THREAD_ID,
		cwd: '/tmp',
		agent: { id: 'agent', name: 'Agent' },
	} as Parameters<InMemorySessionLog['append']>[1])
	const ids = messages.map(() => generateMessageId())
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: ids[0] as MessageId,
		config: { model: 'mock-model', tokenBudget: 0, timeoutMs: 0 },
	})
	for (const [index, message] of messages.entries()) {
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId: ids[index] as MessageId,
			role: message.role,
			content: message,
		})
	}
	await log.release(lease)
	return ids
}

async function seedIdleSubSession(store: InMemorySessionStore) {
	const project = await store.createProject(
		{ tenantId: DEFAULT_TENANT, name: 'archive' },
		DEFAULT_TENANT,
	)
	const parent = await store.createSession(
		{
			topicId: TEST_THREAD_ID,
			projectId: project.id,
			currentActor: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
		},
		DEFAULT_TENANT,
	)
	const child = await store.createSession(
		{
			topicId: TEST_THREAD_ID,
			projectId: project.id,
			currentActor: agentActor('f3e96ab1-b287-4117-bda9-bb0c78eeb909'),
		},
		DEFAULT_TENANT,
	)
	const sub = await store.createSubSession(
		{
			parentSessionId: parent.id,
			childSessionId: child.id,
			kind: 'agent_spawn',
			spawnedBy: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
		},
		DEFAULT_TENANT,
	)
	await store.updateSubSession({ ...sub, status: 'idle' }, DEFAULT_TENANT)
	return { project, parent, child, sub }
}

describe('Integration — retention archive / restore', () => {
	let rootDir: string
	let store: InMemorySessionStore
	let backend: DiskArchiveBackend

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), 'namzu-integration-retention-'))
		store = new InMemorySessionStore()
		backend = new DiskArchiveBackend({ rootDir })
	})

	afterEach(() => {
		sessionLogs.clear()
		removeTempDir(rootDir)
	})

	it('archive idle sub-session → tombstone attached (status=archived + archiveRef + archivedAt)', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
		})

		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)
		expect(tombstone.archiveRef.startsWith('arc_')).toBe(true)

		const after = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(after?.status).toBe('archived')
		expect(after?.archiveRef).toBe(tombstone.archiveRef)
		expect(after?.archivedAt).toBeInstanceOf(Date)
	})

	it('drill(parent) post-archive: archived SubSession still navigable with tombstone fields', async () => {
		const { parent, sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
		})
		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)

		const view = await store.drill(parent.id, DEFAULT_TENANT)
		expect(view?.children).toHaveLength(1)
		const child = view?.children[0]
		expect(child?.id).toBe(sub.id)
		expect(child?.status).toBe('archived')
		expect(child?.archiveRef).toBe(tombstone.archiveRef)
	})

	it('restore recovers the archive bundle with original MessageId fidelity (not synthetic msg_restored_N)', async () => {
		const { sub, child, project } = await seedIdleSubSession(store)
		const [msg1Id, msg2Id] = await recordMessages(child.id, project.id, [
			createUserMessage('first'),
			createUserMessage('second'),
		])

		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
		})
		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)

		// Restore via backend directly to verify round-trip fidelity
		// (ArchivalManager.restore does NOT return the bundle — it only flips
		// status back to idle).
		const bundle = await backend.restore(tombstone.archiveRef)
		expect(bundle.messages).toHaveLength(2)
		expect(bundle.messages[0]?.id).toBe(msg1Id)
		expect(bundle.messages[1]?.id).toBe(msg2Id)
		expect(bundle.messages[0]?.id.startsWith('9da865bb-8464-48ec-9aa9-573faacc5567')).toBe(false)

		await manager.restore(sub.id, DEFAULT_TENANT)
		const after = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(after?.status).toBe('idle')
		expect(after?.archiveRef).toBeUndefined()
		expect(after?.archivedAt).toBeUndefined()
	})

	it('deny-by-default: project without archiveBackend → ArchiveNotConfiguredError on archive()', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			// archiveBackend omitted — archival fully disabled.
		})

		await expect(manager.archive(sub.id, DEFAULT_TENANT)).rejects.toBeInstanceOf(
			ArchiveNotConfiguredError,
		)

		// Sub-session untouched.
		const after = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(after?.status).toBe('idle')
	})

	it('idempotent dispose: workspace already disposed → archive completes without error', async () => {
		const { sub } = await seedIdleSubSession(store)

		// Registry with a driver whose `dispose` throws a generic error.
		const registry = new WorkspaceBackendRegistry()
		registry.register({
			kind: 'git-worktree',
			async create() {
				return {
					id: 'a224544c-9817-4e60-a141-1fcf5f8331ef' as WorkspaceId,
					meta: {
						backend: 'git-worktree',
						repoRoot: '/r',
						branch: 'main',
						worktreePath: '/r/x',
					},
					createdAt: new Date(),
				}
			},
			async branch(ref) {
				return ref
			},
			async dispose() {
				throw new Error('simulated already-disposed race')
			},
			async inspect() {
				return { exists: false, currentRef: 'HEAD', isDirty: false }
			},
		})

		const workspaceRef: WorkspaceRef = {
			id: '08f6dbd8-6056-49e9-a8f3-5e5c4d6d67f0' as WorkspaceId,
			meta: { backend: 'git-worktree', repoRoot: '/r', branch: 'main', worktreePath: '/r/y' },
			createdAt: new Date(),
		}
		await store.updateSubSession(
			{ ...sub, status: 'idle', workspaceId: workspaceRef.id },
			DEFAULT_TENANT,
		)

		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: registry,
			archiveBackend: backend,
			workspaceResolver: async () => workspaceRef,
		})

		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)
		expect(tombstone.archiveRef.startsWith('arc_')).toBe(true)

		// Committed record persists despite dispose failure.
		const after = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(after?.status).toBe('archived')
	})

	it('archive full round-trip: archive → restore → archive again succeeds', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
		})
		const tombstone1 = await manager.archive(sub.id, DEFAULT_TENANT)
		await manager.restore(sub.id, DEFAULT_TENANT)

		const after = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(after?.status).toBe('idle')

		// Re-archive produces a fresh tombstone.
		const tombstone2 = await manager.archive(sub.id, DEFAULT_TENANT)
		expect(tombstone2.archiveRef).not.toBe(tombstone1.archiveRef)
	})

	it('onArchived callback receives the tombstone exactly once', async () => {
		const { sub } = await seedIdleSubSession(store)
		const onArchived = vi.fn()
		const manager = new ArchivalManager({
			sessionStore: store,
			readSessionMessages: readMessages,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
			onArchived,
		})
		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)
		expect(onArchived).toHaveBeenCalledTimes(1)
		expect(onArchived).toHaveBeenCalledWith(tombstone)
	})
})
