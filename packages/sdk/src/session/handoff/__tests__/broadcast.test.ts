import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadManager } from '../../../manager/thread/lifecycle.js'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import {
	type ExecFile,
	type ExecFileResult,
	GitWorktreeDriver,
} from '../../../session/workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import type { ProjectId } from '../../../types/session/ids.js'
import { generateHandoffId } from '../../../utils/id.js'
import type { HandoffAssignment } from '../assignment.js'
import { type BroadcastHandoffDeps, executeBroadcastHandoff } from '../broadcast.js'
import { DefaultCapacityValidator } from '../capacity.js'
import type {
	HandoffBroadcastRollbackEvent,
	HandoffCommittedEvent,
	HandoffEventSink,
	HandoffLockedEvent,
	HandoffUnlockedEvent,
} from '../events.js'
import { HandoffVersionConflict } from '../version.js'

const tenant = 'tnt_alpha' as TenantId

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

function okExec(stdout = '', stderr = ''): ExecFileResult {
	return { stdout, stderr }
}

function user(userId: string): ActorRef {
	return { kind: 'user', userId: userId as UserId, tenantId: tenant }
}

interface MockedHandoffEventSink extends HandoffEventSink {
	onLocked: ReturnType<typeof vi.fn<(ev: HandoffLockedEvent) => void>>
	onUnlocked: ReturnType<typeof vi.fn<(ev: HandoffUnlockedEvent) => void>>
	onCommitted: ReturnType<typeof vi.fn<(ev: HandoffCommittedEvent) => void>>
	onBroadcastRollback: ReturnType<typeof vi.fn<(ev: HandoffBroadcastRollbackEvent) => void>>
}

interface DepsBundle {
	deps: BroadcastHandoffDeps
	events: MockedHandoffEventSink
}

function buildDeps(
	store: InMemorySessionStore,
	threadStore: InMemoryThreadStore,
	execOverride?: ExecFile,
): DepsBundle {
	const exec: ExecFile = execOverride ? execOverride : async (_file, _args) => okExec()
	const driver = new GitWorktreeDriver({
		repoRoot: '/repo',
		logger: stubLogger(),
		execFile: exec,
	})
	const registry = new WorkspaceBackendRegistry()
	registry.register(driver)

	const events: MockedHandoffEventSink = {
		onLocked: vi.fn<(ev: HandoffLockedEvent) => void>(),
		onUnlocked: vi.fn<(ev: HandoffUnlockedEvent) => void>(),
		onCommitted: vi.fn<(ev: HandoffCommittedEvent) => void>(),
		onBroadcastRollback: vi.fn<(ev: HandoffBroadcastRollbackEvent) => void>(),
	}

	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	return {
		deps: {
			store,
			workspaceRegistry: registry,
			capacity: new DefaultCapacityValidator(store),
			events,
			threadManager,
		},
		events,
	}
}

async function seedIdle(store: InMemorySessionStore, threadStore: InMemoryThreadStore) {
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'handoff-broadcast-test' },
		tenant,
	)
	const session = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: user('usr_source') },
		tenant,
	)
	return { project, thread, session }
}

function buildAssignments(
	sourceSessionId: SessionId,
	projectId: ProjectId,
	threadId: Awaited<ReturnType<InMemoryThreadStore['createThread']>>['id'],
	expectedOwnerVersion: number,
	recipients: ActorRef[],
	broadcastId = 'bc_1',
): HandoffAssignment[] {
	return recipients.map((recipientActor) => ({
		id: generateHandoffId(),
		mode: 'broadcast' as const,
		sourceSessionId,
		tenantId: tenant,
		threadId,
		projectId,
		sourceActor: user('usr_source'),
		recipientActor,
		expectedOwnerVersion,
		broadcastId,
		createdAt: new Date('2026-02-01'),
	}))
}

describe('executeBroadcastHandoff', () => {
	let store: InMemorySessionStore
	let threadStore: InMemoryThreadStore

	beforeEach(() => {
		store = new InMemorySessionStore()
		threadStore = new InMemoryThreadStore()
	})

	it('happy path: 3 recipients → source ends in awaiting_merge with 3 new children', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps, events } = buildDeps(store, threadStore)

		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [
			user('usr_bob'),
			user('usr_carol'),
			user('usr_dan'),
		])

		const outcomes = await executeBroadcastHandoff(deps, assignments, tenant)
		expect(outcomes).toHaveLength(3)
		expect(new Set(outcomes.map((o) => o.newSessionId)).size).toBe(3)
		expect(outcomes.every((o) => o.committedOwnerVersion === 1)).toBe(true)

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('awaiting_merge')
		expect(reloaded?.ownerVersion).toBe(1)

		const children = await store.getChildren(session.id, tenant)
		expect(children).toHaveLength(3)

		expect(events.onLocked).toHaveBeenCalledTimes(1)
		expect(events.onCommitted).toHaveBeenCalledTimes(1)
		expect(events.onBroadcastRollback).not.toHaveBeenCalled()
	})

	it('rollback on mid-fan-out failure (2nd recipient worktree add fails): source reverts, rollback emits accurate partialState', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)

		let addCount = 0
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				addCount += 1
				if (addCount === 2) throw new Error('simulated mid-fanout failure')
			}
			return okExec()
		}
		const { deps, events } = buildDeps(store, threadStore, exec)

		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [
			user('usr_b'),
			user('usr_c'),
			user('usr_d'),
		])

		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow(
			/Workspace backend git-worktree failed on create/,
		)

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)

		// The first recipient got through all three sub-ops; the second failed
		// during worktree provisioning. partialState reports:
		//   worktreesProvisioned: 1 (the first recipient's)
		//   subsessionsCreated: 1 (the first recipient's)
		//   assignmentsWritten: 1 (the first recipient's)
		expect(events.onBroadcastRollback).toHaveBeenCalledTimes(1)
		const rollbackCall = events.onBroadcastRollback.mock.calls[0]?.[0]
		expect(rollbackCall).toBeDefined()
		expect(rollbackCall?.partialState.worktreesProvisioned).toBe(1)
		expect(rollbackCall?.partialState.subsessionsCreated).toBe(1)
		expect(rollbackCall?.partialState.assignmentsWritten).toBe(1)
		expect(rollbackCall?.broadcastId).toBe('bc_1')

		// Phase 8: rollback now fully deletes partial records rather than
		// flipping them to 'archived'. The source session has no children and
		// no orphan child sessions remain under the project.
		const children = await store.getChildren(session.id, tenant)
		expect(children).toHaveLength(0)
	})

	it('rollback performs full cleanup via deleteSubSession/deleteSession (no status-flip stopgap)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)

		let addCount = 0
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				addCount += 1
				if (addCount === 2) throw new Error('simulated failure')
			}
			return okExec()
		}
		const { deps } = buildDeps(store, threadStore, exec)

		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [
			user('usr_b'),
			user('usr_c'),
		])

		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow()

		// No sub-session record remains.
		const children = await store.getChildren(session.id, tenant)
		expect(children).toHaveLength(0)

		// Source is back to idle with its original ownerVersion (unchanged because
		// the CAS commit never landed).
		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
	})

	it('rollback idempotency: worktree dispose throwing during rollback does not bubble a secondary failure', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)

		let addCount = 0
		let removeCount = 0
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				addCount += 1
				if (addCount === 2) throw new Error('primary: mid-fanout add failure')
			}
			if (args.includes('remove')) {
				removeCount += 1
				// Throw an unclassified error so the regex in dispose does NOT treat
				// it as idempotent success — exercises the outer try/catch in the
				// rollback loop.
				throw new Error('secondary rollback dispose failure (unexpected)')
			}
			return okExec()
		}
		const { deps, events } = buildDeps(store, threadStore, exec)

		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [
			user('usr_b'),
			user('usr_c'),
		])

		// Outer failure is the PRIMARY one — the secondary dispose failure is
		// swallowed. Primary wraps in WorkspaceBackendError (create op).
		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow(
			/Workspace backend git-worktree failed on create/,
		)

		expect(removeCount).toBeGreaterThanOrEqual(1)
		expect(events.onBroadcastRollback).toHaveBeenCalledTimes(1)

		// Source is idle (rollback succeeded at the store layer even if dispose
		// partially failed).
		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
	})

	it('dedupe: two assignments targeting same recipient → rejected pre-lock (no side effects)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps, events } = buildDeps(store, threadStore)

		const bob = user('usr_bob')
		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [
			bob,
			bob,
			user('usr_dan'),
		])

		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow(
			/duplicate recipient/,
		)

		// Source never locked — no events fired.
		expect(events.onLocked).not.toHaveBeenCalled()
		expect(events.onCommitted).not.toHaveBeenCalled()
		expect(events.onBroadcastRollback).not.toHaveBeenCalled()
		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
	})

	it('width cap: 9 recipients exceeds default maxWidth=8 → rejected before source lock', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps, events } = buildDeps(store, threadStore)

		const recipients = Array.from({ length: 9 }, (_, i) => user(`usr_${i}`))
		const assignments = buildAssignments(session.id, project.id, thread.id, 0, recipients)

		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow(
			/Delegation capacity exceeded/,
		)
		expect(events.onLocked).not.toHaveBeenCalled()
		expect(events.onBroadcastRollback).not.toHaveBeenCalled()

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
	})

	it('concurrent broadcast on same source: second attempt rejected with HandoffVersionConflict', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps } = buildDeps(store, threadStore)

		const firstAssignments = buildAssignments(
			session.id,
			project.id,
			thread.id,
			0,
			[user('usr_b'), user('usr_c')],
			'bc_1',
		)
		await executeBroadcastHandoff(deps, firstAssignments, tenant)

		// Second broadcast still has expectedOwnerVersion = 0 but source is now 1.
		// It should also observe source.status === 'awaiting_merge' (non-idle) —
		// that rejects with HandoffLockRejected BEFORE the CAS check fires. To
		// exercise the CAS path, reset source to `idle` (simulating all recipients
		// completing) and THEN attempt the second handoff with stale expected=0.
		const reloaded = await store.getSession(session.id, tenant)
		if (!reloaded) throw new Error('source missing')
		await store.updateSession({ ...reloaded, status: 'idle' }, tenant)

		const second = buildAssignments(
			session.id,
			project.id,
			thread.id,
			0, // stale — actual is 1
			[user('usr_d'), user('usr_e')],
			'bc_2',
		)
		await expect(executeBroadcastHandoff(deps, second, tenant)).rejects.toBeInstanceOf(
			HandoffVersionConflict,
		)
	})

	it('empty assignments → throws a descriptive error', async () => {
		const { deps } = buildDeps(store, threadStore)
		await expect(executeBroadcastHandoff(deps, [], tenant)).rejects.toThrow(
			/assignments must not be empty/,
		)
	})

	it('single-row broadcast → rejected (caller must use executeSingleHandoff)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps } = buildDeps(store, threadStore)
		const assignments = buildAssignments(session.id, project.id, thread.id, 0, [user('usr_b')])

		await expect(executeBroadcastHandoff(deps, assignments, tenant)).rejects.toThrow(
			/single-recipient handoffs must use executeSingleHandoff/,
		)
	})
})
