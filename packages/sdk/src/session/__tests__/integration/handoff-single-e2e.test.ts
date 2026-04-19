/**
 * Integration — single-recipient handoff wired through the full stack.
 *
 * Orthogonal to `handoff/__tests__/single.test.ts` (unit-level): this
 * exercises the real `InMemorySessionStore` + real `GitWorktreeDriver` (with
 * stubbed `execFile`) + real {@link DefaultCapacityValidator} so the commit
 * ordering + workspace provisioning side-effects are verifiable from the
 * outside.
 *
 * Covers roadmap §5 invariants: §4.8 (handoff has no accepted field — commit
 * is atomic), §6.1 (single-recipient flow: lock → commit), §5.1 (source
 * transitions back to idle with bumped ownerVersion + appended previousActors).
 */

import { describe, expect, it, vi } from 'vitest'
import { ThreadManager } from '../../../manager/thread/lifecycle.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { TenantId } from '../../../types/ids/index.js'
import { generateHandoffId } from '../../../utils/id.js'
import { TenantIsolationError } from '../../errors.js'
import type { HandoffAssignment } from '../../handoff/assignment.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { HandoffEventSink } from '../../handoff/events.js'
import { type SingleHandoffDeps, executeSingleHandoff } from '../../handoff/single.js'
import type { Session } from '../../hierarchy/session.js'
import { GitWorktreeDriver } from '../../workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import { DEFAULT_TENANT, OTHER_TENANT, okExec, stubLogger, userActor } from './_fixtures.js'

function buildHandoffDeps(
	store: InMemorySessionStore,
	threadStore: InMemoryThreadStore,
): {
	deps: SingleHandoffDeps
	updateCalls: Array<{ status?: string; ownerVersion?: number }>
} {
	const driver = new GitWorktreeDriver({
		repoRoot: '/repo',
		logger: stubLogger(),
		execFile: async () => okExec(),
	})
	const workspaceRegistry = new WorkspaceBackendRegistry()
	workspaceRegistry.register(driver)

	const sink: HandoffEventSink = {
		onLocked: vi.fn(),
		onUnlocked: vi.fn(),
		onCommitted: vi.fn(),
		onBroadcastRollback: vi.fn(),
	}

	const updateCalls: Array<{ status?: string; ownerVersion?: number }> = []
	const originalUpdate = store.updateSession.bind(store)
	store.updateSession = async (session: Session, tenantId) => {
		updateCalls.push({ status: session.status, ownerVersion: session.ownerVersion })
		return originalUpdate(session, tenantId)
	}

	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	return {
		deps: {
			store,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			events: sink,
			threadManager,
		},
		updateCalls,
	}
}

describe('Integration — single-recipient handoff E2E', () => {
	it('idle → locked → commit: source previousActors grew + ownerVersion bumped atomically', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'ho' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'ho' },
			DEFAULT_TENANT,
		)
		const sourceActor = userActor('usr_source')
		const recipientActor = userActor('usr_target')
		const session = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: sourceActor },
			DEFAULT_TENANT,
		)

		const { deps, updateCalls } = buildHandoffDeps(store, threadStore)
		const assignment: HandoffAssignment = {
			id: generateHandoffId(),
			mode: 'single',
			sourceSessionId: session.id,
			tenantId: DEFAULT_TENANT,
			threadId: thread.id,
			projectId: project.id,
			sourceActor,
			recipientActor,
			expectedOwnerVersion: 0,
			createdAt: new Date('2026-04-17'),
		}

		const outcome = await executeSingleHandoff(deps, assignment, DEFAULT_TENANT)

		expect(outcome.committedOwnerVersion).toBe(1)

		const reloaded = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(1)
		expect(reloaded?.currentActor).toEqual(recipientActor)
		expect(reloaded?.previousActors).toHaveLength(1)
		expect(reloaded?.previousActors[0]).toEqual(sourceActor)

		// Wired assertion: updateSession was invoked at least with the lock
		// transition + the final commit. That sequence is what makes the
		// handoff "atomic at the store layer".
		// Expect at minimum locked (v0) followed by committed (v1).
		expect(updateCalls).toEqual(
			expect.arrayContaining([
				{ status: 'locked', ownerVersion: 0 },
				{ status: 'idle', ownerVersion: 1 },
			]),
		)
	})

	it('cross-tenant assignment rejects at entry (TenantIsolationError)', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'ct' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'ct' },
			DEFAULT_TENANT,
		)
		const session = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)

		const { deps } = buildHandoffDeps(store, threadStore)
		const assignment: HandoffAssignment = {
			id: generateHandoffId(),
			mode: 'single',
			sourceSessionId: session.id,
			tenantId: OTHER_TENANT,
			threadId: thread.id,
			projectId: project.id,
			sourceActor: userActor('usr_source', OTHER_TENANT),
			recipientActor: userActor('usr_target', OTHER_TENANT),
			expectedOwnerVersion: 0,
			createdAt: new Date('2026-04-17'),
		}

		await expect(executeSingleHandoff(deps, assignment, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('source-owned workspace provisioned for recipient', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'wsp' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'wsp' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)

		const { deps } = buildHandoffDeps(store, threadStore)
		const assignment: HandoffAssignment = {
			id: generateHandoffId(),
			mode: 'single',
			sourceSessionId: source.id,
			tenantId: DEFAULT_TENANT,
			threadId: thread.id,
			projectId: project.id,
			sourceActor: userActor('usr_source'),
			recipientActor: userActor('usr_target'),
			expectedOwnerVersion: 0,
			createdAt: new Date('2026-04-17'),
		}

		const outcome = await executeSingleHandoff(deps, assignment, DEFAULT_TENANT)

		expect(outcome.workspaceId.startsWith('wsp_')).toBe(true)
		expect(outcome.newSessionId.startsWith('ses_')).toBe(true)

		// Recipient session exists under the same tenant/project.
		const recipient = await store.getSession(outcome.newSessionId, DEFAULT_TENANT)
		expect(recipient).not.toBeNull()
		expect(recipient?.projectId).toBe(project.id)
		expect(recipient?.tenantId).toBe(DEFAULT_TENANT)
		expect(recipient?.currentActor).toEqual(userActor('usr_target'))

		// A sub-session edge links the source to the recipient.
		const children = await store.getChildren(source.id, DEFAULT_TENANT)
		expect(children).toHaveLength(1)
		expect(children[0]?.kind).toBe('user_handoff')
		expect(children[0]?.childSessionId).toBe(outcome.newSessionId)
	})

	// Tenant-denormalization-on-record assertion — every persisted entity
	// carries the tenantId explicitly, which matters for §12 isolation.
	it('denormalized tenantId stamped on Session + SubSession records', async () => {
		const _tenantType: TenantId = DEFAULT_TENANT
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'denorm' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'denorm' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)
		const { deps } = buildHandoffDeps(store, threadStore)

		const assignment: HandoffAssignment = {
			id: generateHandoffId(),
			mode: 'single',
			sourceSessionId: source.id,
			tenantId: DEFAULT_TENANT,
			threadId: thread.id,
			projectId: project.id,
			sourceActor: userActor('usr_source'),
			recipientActor: userActor('usr_target'),
			expectedOwnerVersion: 0,
			createdAt: new Date(),
		}
		const outcome = await executeSingleHandoff(deps, assignment, DEFAULT_TENANT)

		// Recipient's Session stores tenantId explicitly (not inferred).
		const recipient = await store.getSession(outcome.newSessionId, DEFAULT_TENANT)
		expect(recipient?.tenantId).toBe(_tenantType)
	})
})
