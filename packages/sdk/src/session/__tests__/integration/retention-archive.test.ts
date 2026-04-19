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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ThreadId, WorkspaceId } from '../../../types/session/ids.js'
import { ArchivalManager, ArchiveNotConfiguredError } from '../../retention/archive.js'
import { DiskArchiveBackend } from '../../retention/disk-backend.js'
import type { WorkspaceRef } from '../../workspace/ref.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import { DEFAULT_TENANT, agentActor, userActor } from './_fixtures.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

async function seedIdleSubSession(store: InMemorySessionStore) {
	const project = await store.createProject(
		{ tenantId: DEFAULT_TENANT, name: 'archive' },
		DEFAULT_TENANT,
	)
	const parent = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_a') },
		DEFAULT_TENANT,
	)
	const child = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_w') },
		DEFAULT_TENANT,
	)
	const sub = await store.createSubSession(
		{
			parentSessionId: parent.id,
			childSessionId: child.id,
			kind: 'agent_spawn',
			spawnedBy: userActor('usr_a'),
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
		rmSync(rootDir, { recursive: true, force: true })
	})

	it('archive idle sub-session → tombstone attached (status=archived + archiveRef + archivedAt)', async () => {
		const { sub } = await seedIdleSubSession(store)
		const manager = new ArchivalManager({
			sessionStore: store,
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
		const { sub, child } = await seedIdleSubSession(store)
		const msg1Id = await store.appendMessage(child.id, createUserMessage('first'), DEFAULT_TENANT)
		const msg2Id = await store.appendMessage(child.id, createUserMessage('second'), DEFAULT_TENANT)

		const manager = new ArchivalManager({
			sessionStore: store,
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
		expect(bundle.messages[0]?.id.startsWith('msg_restored_')).toBe(false)

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
				throw new Error('simulated already-disposed race')
			},
			async inspect() {
				return { exists: false, currentRef: 'HEAD', isDirty: false }
			},
		})

		const workspaceRef: WorkspaceRef = {
			id: 'wsp_live' as WorkspaceId,
			meta: { backend: 'git-worktree', repoRoot: '/r', branch: 'main', worktreePath: '/r/y' },
			createdAt: new Date(),
		}
		await store.updateSubSession(
			{ ...sub, status: 'idle', workspaceId: workspaceRef.id },
			DEFAULT_TENANT,
		)

		const manager = new ArchivalManager({
			sessionStore: store,
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
			workspaceRegistry: new WorkspaceBackendRegistry(),
			archiveBackend: backend,
			onArchived,
		})
		const tombstone = await manager.archive(sub.id, DEFAULT_TENANT)
		expect(onArchived).toHaveBeenCalledTimes(1)
		expect(onArchived).toHaveBeenCalledWith(tombstone)
	})
})
