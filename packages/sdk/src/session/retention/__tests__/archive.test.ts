import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ExecFile, GitWorktreeDriver } from '../../../session/workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { AgentId, TenantId, UserId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ThreadId, WorkspaceId } from '../../../types/session/ids.js'
import type { SubSession } from '../../../types/session/sub-session.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import {
	ArchivalManager,
	ArchiveNotConfiguredError,
	SubSessionNotArchivableError,
} from '../archive.js'
import { DiskArchiveBackend } from '../disk-backend.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

const tenantA = 'tnt_alpha' as TenantId

function stubLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	}
}

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId }
}

async function seedIdleSubSession(store: InMemorySessionStore) {
	const project = await store.createProject({ tenantId: tenantA, name: 'p' }, tenantA)
	const parent = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor(tenantA) },
		tenantA,
	)
	const child = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
		tenantA,
	)
	const sub = await store.createSubSession(
		{
			parentSessionId: parent.id,
			childSessionId: child.id,
			kind: 'agent_spawn',
			spawnedBy: userActor(tenantA),
		},
		tenantA,
	)
	// Flip the newly-created sub-session from 'pending' → 'idle' so it's
	// eligible for archival.
	await store.updateSubSession({ ...sub, status: 'idle' }, tenantA)
	return { project, parent, child, sub }
}

function buildRegistry(): WorkspaceBackendRegistry {
	const exec: ExecFile = async () => ({ stdout: '', stderr: '' })
	const driver = new GitWorktreeDriver({
		repoRoot: '/repo',
		logger: stubLogger(),
		execFile: exec,
	})
	const registry = new WorkspaceBackendRegistry()
	registry.register(driver)
	return registry
}

describe('ArchivalManager', () => {
	let rootDir: string
	let store: InMemorySessionStore
	let backend: DiskArchiveBackend

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), 'namzu-retention-archive-'))
		store = new InMemorySessionStore()
		backend = new DiskArchiveBackend({ rootDir })
	})

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true })
	})

	it('archive happy path: idle sub-session → tombstone attached, backend called once', async () => {
		const { sub, child } = await seedIdleSubSession(store)
		await store.appendMessage(child.id, createUserMessage('hi'), tenantA)

		const storeSpy = vi.spyOn(backend, 'store')
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})

		const tombstone = await manager.archive(sub.id, tenantA)

		expect(tombstone.subSessionId).toBe(sub.id)
		expect(tombstone.archiveRef).toMatch(/^arc_/)
		expect(tombstone.archivedAt).toBeInstanceOf(Date)
		expect(storeSpy).toHaveBeenCalledTimes(1)

		const after = await store.getSubSession(sub.id, tenantA)
		expect(after?.status).toBe('archived')
		expect(after?.archiveRef).toBe(tombstone.archiveRef)
		expect(after?.archivedAt).toBeInstanceOf(Date)
	})

	it('rejects non-archivable statuses (running/active → not_idle)', async () => {
		const { sub } = await seedIdleSubSession(store)
		await store.updateSubSession({ ...sub, status: 'active' }, tenantA)

		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})

		await expect(manager.archive(sub.id, tenantA)).rejects.toBeInstanceOf(
			SubSessionNotArchivableError,
		)
	})

	it('rejects already-archived sub-sessions', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})
		await manager.archive(sub.id, tenantA)

		await expect(manager.archive(sub.id, tenantA)).rejects.toMatchObject({
			name: 'SubSessionNotArchivableError',
			details: { reason: 'already_archived' },
		})
	})

	it('rejects missing sub-sessions', async () => {
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})
		await expect(manager.archive('sub_missing' as SubSession['id'], tenantA)).rejects.toMatchObject(
			{ name: 'SubSessionNotArchivableError', details: { reason: 'missing' } },
		)
	})

	it('deny-by-default: backend absent → ArchiveNotConfiguredError', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			// archiveBackend intentionally omitted.
		})
		await expect(manager.archive(sub.id, tenantA)).rejects.toBeInstanceOf(ArchiveNotConfiguredError)
	})

	it('restore reads tombstone, invokes backend.restore, flips status back to idle', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})
		await manager.archive(sub.id, tenantA)

		const restoreSpy = vi.spyOn(backend, 'restore')
		await manager.restore(sub.id, tenantA)

		expect(restoreSpy).toHaveBeenCalledTimes(1)
		const after = await store.getSubSession(sub.id, tenantA)
		expect(after?.status).toBe('idle')
		expect(after?.archiveRef).toBeUndefined()
		expect(after?.archivedAt).toBeUndefined()
	})

	it('tombstone is navigable via drill post-archive with status=archived + archiveRef', async () => {
		const { parent, sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
		})
		const tombstone = await manager.archive(sub.id, tenantA)

		const view = await store.drill(parent.id, tenantA)
		expect(view).not.toBeNull()
		expect(view?.children).toHaveLength(1)
		const child = view?.children[0]
		expect(child?.id).toBe(sub.id)
		expect(child?.status).toBe('archived')
		expect(child?.archiveRef).toBe(tombstone.archiveRef)
		expect(child?.archivedAt).toBeInstanceOf(Date)
	})

	it('workspace disposal failures do not unwind the committed archive', async () => {
		const { sub } = await seedIdleSubSession(store)

		// Registry with a driver whose `dispose` always throws.
		const registry = new WorkspaceBackendRegistry()
		registry.register({
			kind: 'git-worktree',
			async create() {
				return {
					id: 'wsp_x' as WorkspaceId,
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
				throw new Error('dispose boom')
			},
			async inspect() {
				return { exists: true, currentRef: 'HEAD', isDirty: false }
			},
		})

		const workspaceRef: WorkspaceRef = {
			id: 'wsp_y' as WorkspaceId,
			meta: { backend: 'git-worktree', repoRoot: '/r', branch: 'main', worktreePath: '/r/y' },
			createdAt: new Date(),
		}
		// Seed the sub-session with a workspaceId and a resolver that returns
		// the live ref.
		await store.updateSubSession({ ...sub, status: 'idle', workspaceId: workspaceRef.id }, tenantA)

		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: registry,
			archiveBackend: backend,
			workspaceResolver: async () => workspaceRef,
		})

		// Archive must complete even though dispose throws internally.
		const tombstone = await manager.archive(sub.id, tenantA)
		expect(tombstone.archiveRef).toMatch(/^arc_/)

		const after = await store.getSubSession(sub.id, tenantA)
		expect(after?.status).toBe('archived')
	})

	it('SessionMessage round-trip: archive preserves original MessageId + timestamps', async () => {
		// Phase 9 Known Delta #7: ArchivalManager now uses
		// SessionStore.loadSessionMessages for full-fidelity archival (no more
		// synthetic `msg_restored_N` IDs).
		const { sub, child } = await seedIdleSubSession(store)
		const id1 = await store.appendMessage(child.id, createUserMessage('m1'), tenantA)
		const id2 = await store.appendMessage(child.id, createUserMessage('m2'), tenantA)

		const captured: unknown[] = []
		const capturingBackend: DiskArchiveBackend = Object.assign(
			new DiskArchiveBackend({ rootDir }),
			{
				store: vi.fn(async (bundle: unknown) => {
					captured.push(bundle)
					return {
						archiveRef: 'arc_test_ref',
						archivedAt: new Date(),
					}
				}),
			},
		) as unknown as DiskArchiveBackend

		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: capturingBackend,
		})
		await manager.archive(sub.id, tenantA)

		expect(captured).toHaveLength(1)
		const bundle = captured[0] as {
			messages: Array<{ id: string; at: Date; message: unknown }>
		}
		expect(bundle.messages).toHaveLength(2)
		expect(bundle.messages[0]?.id).toBe(id1)
		expect(bundle.messages[1]?.id).toBe(id2)
		expect(bundle.messages[0]?.id).not.toMatch(/^msg_restored_/)
		expect(bundle.messages[0]?.at).toBeInstanceOf(Date)
	})

	it('onArchived callback fires exactly once on success with the tombstone', async () => {
		const { sub } = await seedIdleSubSession(store)
		const onArchived = vi.fn()
		const manager = new ArchivalManager({
			sessionStore: store,
			workspaceRegistry: buildRegistry(),
			archiveBackend: backend,
			onArchived,
		})
		const tombstone = await manager.archive(sub.id, tenantA)

		expect(onArchived).toHaveBeenCalledTimes(1)
		expect(onArchived).toHaveBeenCalledWith(tombstone)
	})
})
