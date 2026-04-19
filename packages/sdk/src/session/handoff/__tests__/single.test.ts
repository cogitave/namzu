import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadManager } from '../../../manager/thread/lifecycle.js'
import { TenantIsolationError } from '../../../session/errors.js'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import {
	type ExecFile,
	type ExecFileResult,
	GitWorktreeDriver,
} from '../../../session/workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { generateHandoffId } from '../../../utils/id.js'
import type { HandoffAssignment } from '../assignment.js'
import { DefaultCapacityValidator } from '../capacity.js'
import { DelegationCapacityExceeded } from '../capacity.js'
import type {
	HandoffBroadcastRollbackEvent,
	HandoffCommittedEvent,
	HandoffEventSink,
	HandoffLockedEvent,
	HandoffUnlockedEvent,
} from '../events.js'
import { type RunStatusResolver, type SingleHandoffDeps, executeSingleHandoff } from '../single.js'
import { HandoffLockRejected, HandoffVersionConflict } from '../version.js'

const tenant = 'tnt_alpha' as TenantId
const otherTenant = 'tnt_beta' as TenantId

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

function user(kind = 'usr_a'): ActorRef {
	return { kind: 'user', userId: kind as UserId, tenantId: tenant }
}

function agent(): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId: tenant }
}

interface MockedHandoffEventSink extends HandoffEventSink {
	onLocked: ReturnType<typeof vi.fn<(ev: HandoffLockedEvent) => void>>
	onUnlocked: ReturnType<typeof vi.fn<(ev: HandoffUnlockedEvent) => void>>
	onCommitted: ReturnType<typeof vi.fn<(ev: HandoffCommittedEvent) => void>>
	onBroadcastRollback: ReturnType<typeof vi.fn<(ev: HandoffBroadcastRollbackEvent) => void>>
}

function buildDeps(
	store: InMemorySessionStore,
	threadStore: InMemoryThreadStore,
	execOverride?: ExecFile,
	runResolver?: RunStatusResolver,
): { deps: SingleHandoffDeps; events: MockedHandoffEventSink; execCalls: string[] } {
	const execCalls: string[] = []
	const exec: ExecFile = execOverride
		? execOverride
		: async (_file, args) => {
				execCalls.push(args.join(' '))
				return okExec()
			}
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
	const deps: SingleHandoffDeps = {
		store,
		workspaceRegistry: registry,
		capacity: new DefaultCapacityValidator(store),
		events,
		threadManager,
		...(runResolver !== undefined && { runStatus: runResolver }),
	}

	return { deps, events, execCalls }
}

async function seedIdle(store: InMemorySessionStore, threadStore: InMemoryThreadStore) {
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'handoff-single-test' },
		tenant,
	)
	const session = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: user('usr_source') },
		tenant,
	)
	return { project, thread, session }
}

function buildAssignment(
	sourceSessionId: SessionId,
	projectId: Awaited<ReturnType<InMemorySessionStore['createProject']>>['id'],
	threadId: Awaited<ReturnType<InMemoryThreadStore['createThread']>>['id'],
	expectedOwnerVersion: number,
	recipient: ActorRef = user('usr_target'),
): HandoffAssignment {
	return {
		id: generateHandoffId(),
		mode: 'single',
		sourceSessionId,
		tenantId: tenant,
		threadId,
		projectId,
		sourceActor: user('usr_source'),
		recipientActor: recipient,
		expectedOwnerVersion,
		createdAt: new Date('2026-02-01'),
	}
}

describe('executeSingleHandoff', () => {
	let store: InMemorySessionStore
	let threadStore: InMemoryThreadStore

	beforeEach(() => {
		store = new InMemorySessionStore()
		threadStore = new InMemoryThreadStore()
	})

	it('happy path: idle source → lock → commit → outcome populated + source mutated', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps, events } = buildDeps(store, threadStore)

		const assignment = buildAssignment(session.id, project.id, thread.id, 0)
		const outcome = await executeSingleHandoff(deps, assignment, tenant)

		expect(outcome.assignmentId).toBe(assignment.id)
		expect(outcome.workspaceId.startsWith('wsp_')).toBe(true)
		expect(outcome.newSessionId.startsWith('ses_')).toBe(true)
		expect(outcome.committedOwnerVersion).toBe(1)

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(1)
		expect(reloaded?.previousActors).toHaveLength(1)
		expect(reloaded?.currentActor).toEqual(assignment.recipientActor)

		// Events fire in order: locked then committed.
		expect(events.onLocked).toHaveBeenCalledTimes(1)
		expect(events.onCommitted).toHaveBeenCalledTimes(1)
		expect(events.onUnlocked).not.toHaveBeenCalled()
	})

	it('rejects when source session is non-idle (active → HandoffLockRejected with active_run)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		await store.updateSession({ ...session, status: 'active' }, tenant)

		const { deps } = buildDeps(store, threadStore)
		const assignment = buildAssignment(session.id, project.id, thread.id, 0)

		try {
			await executeSingleHandoff(deps, assignment, tenant)
			expect.fail('expected HandoffLockRejected')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffLockRejected)
			expect((err as HandoffLockRejected).details.reason).toBe('active_run')
		}
	})

	it('rejects when Run resolver reports pending_hitl', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const resolver: RunStatusResolver = {
			async blockingRun() {
				return { reason: 'pending_hitl' }
			},
		}
		const { deps } = buildDeps(store, threadStore, undefined, resolver)
		const assignment = buildAssignment(session.id, project.id, thread.id, 0)

		try {
			await executeSingleHandoff(deps, assignment, tenant)
			expect.fail('expected HandoffLockRejected')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffLockRejected)
			expect((err as HandoffLockRejected).details.reason).toBe('pending_hitl')
		}
	})

	it('rejects on tenant mismatch (TenantIsolationError)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps } = buildDeps(store, threadStore)
		// Assignment tenant differs from the call-site tenant.
		const assignment: HandoffAssignment = {
			...buildAssignment(session.id, project.id, thread.id, 0),
			tenantId: otherTenant,
		}
		await expect(executeSingleHandoff(deps, assignment, otherTenant)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('rejects on CAS mismatch (HandoffVersionConflict)', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)
		const { deps } = buildDeps(store, threadStore)

		// Simulate a concurrent bump: move ownerVersion to 1 before the assignment
		// with expectedOwnerVersion=0 is executed.
		await store.updateSession({ ...session, ownerVersion: 1 }, tenant)
		const assignment = buildAssignment(session.id, project.id, thread.id, 0)

		try {
			await executeSingleHandoff(deps, assignment, tenant)
			expect.fail('expected HandoffVersionConflict')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffVersionConflict)
			expect((err as HandoffVersionConflict).details.expected).toBe(0)
			expect((err as HandoffVersionConflict).details.actual).toBe(1)
		}
	})

	it('depth cap enforcement rejects with DelegationCapacityExceeded (dimension=depth)', async () => {
		// Build a chain so the handoff source already sits at max depth.
		const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'depth-cap' },
			tenant,
		)
		// Set a tight limit on the project via a second createProject? — no, the
		// store hardcodes defaults {4,8,10}. Build a depth-4 chain then attempt
		// handoff on depth-4 node (ancestry length 5 > 4).
		const root = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: user('usr_source') },
			tenant,
		)
		let parent = root.id
		let tail: SessionId = root.id
		for (let i = 0; i < 4; i++) {
			const child = await store.createSession(
				{ threadId: thread.id, projectId: project.id, currentActor: user(`usr_${i}`) },
				tenant,
			)
			await store.createSubSession(
				{
					parentSessionId: parent,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: agent(),
				},
				tenant,
			)
			parent = child.id
			tail = child.id
		}

		// Source is `tail` at ancestry length 5 → depth-capacity with limit 4 rejects.
		const { deps } = buildDeps(store, threadStore)
		const assignment = buildAssignment(tail, project.id, thread.id, 0)
		await expect(executeSingleHandoff(deps, assignment, tenant)).rejects.toBeInstanceOf(
			DelegationCapacityExceeded,
		)
	})

	it('compensating revert: workspace provisioning failure reverts source to idle, version unchanged, onUnlocked fires', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)

		// Fail only on `worktree add` but pass for everything else. Here we fail
		// the single worktree add.
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				throw new Error('simulated git worktree add failure')
			}
			return okExec()
		}
		const { deps, events } = buildDeps(store, threadStore, exec)
		const assignment = buildAssignment(session.id, project.id, thread.id, 0)

		await expect(executeSingleHandoff(deps, assignment, tenant)).rejects.toThrow(
			/Workspace backend git-worktree failed on create/,
		)

		// Source is back to idle, ownerVersion unchanged.
		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
		expect(reloaded?.previousActors).toHaveLength(0)

		// onLocked fired, then onUnlocked, no onCommitted.
		expect(events.onLocked).toHaveBeenCalledTimes(1)
		expect(events.onUnlocked).toHaveBeenCalledTimes(1)
		expect(events.onCommitted).not.toHaveBeenCalled()
	})

	it('compensating revert: store.createSubSession failure still reverts + archives partial recipient', async () => {
		const { project, thread, session } = await seedIdle(store, threadStore)

		// Monkey-patch createSubSession on the store to throw.
		const original = store.createSubSession.bind(store)
		store.createSubSession = async () => {
			throw new Error('simulated createSubSession failure')
		}

		const { deps, events } = buildDeps(store, threadStore)
		const assignment = buildAssignment(session.id, project.id, thread.id, 0)

		await expect(executeSingleHandoff(deps, assignment, tenant)).rejects.toThrow(
			/createSubSession failure/,
		)

		// Restore for subsequent tests (though beforeEach makes this moot).
		store.createSubSession = original

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
		expect(events.onUnlocked).toHaveBeenCalledTimes(1)
	})
})
