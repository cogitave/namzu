/**
 * Integration — broadcast handoff atomic fan-out + rollback wired through
 * the real stack.
 *
 * Covers roadmap §5 invariants: §5.4 (source → `awaiting_merge` after
 * successful commit), §6.2 (broadcast atomic rollback — zero orphan
 * sub-sessions/sessions after rollback via `deleteSubSession` +
 * `deleteSession`), §10.2 (broadcast.rollback event carries accurate
 * partialState counts).
 */

import { describe, expect, it, vi } from 'vitest'
import { ThreadManager } from '../../../manager/thread/lifecycle.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { SessionId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { generateHandoffId } from '../../../utils/id.js'
import type { HandoffAssignment } from '../../handoff/assignment.js'
import { type BroadcastHandoffDeps, executeBroadcastHandoff } from '../../handoff/broadcast.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { HandoffEventSink } from '../../handoff/events.js'
import type { ExecFile } from '../../workspace/git-worktree.js'
import { GitWorktreeDriver } from '../../workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import { DEFAULT_TENANT, okExec, stubLogger, userActor } from './_fixtures.js'

function buildDeps(
	store: InMemorySessionStore,
	threadStore: InMemoryThreadStore,
	execOverride?: ExecFile,
): {
	deps: BroadcastHandoffDeps
	events: HandoffEventSink & { onBroadcastRollback: ReturnType<typeof vi.fn> }
} {
	const exec: ExecFile = execOverride ?? (async () => okExec())
	const driver = new GitWorktreeDriver({
		repoRoot: '/repo',
		logger: stubLogger(),
		execFile: exec,
	})
	const workspaceRegistry = new WorkspaceBackendRegistry()
	workspaceRegistry.register(driver)

	const onBroadcastRollback = vi.fn()
	const sink: HandoffEventSink = {
		onLocked: vi.fn(),
		onUnlocked: vi.fn(),
		onCommitted: vi.fn(),
		onBroadcastRollback,
	}

	return {
		deps: {
			store,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			events: sink,
			threadManager: new ThreadManager({ threadStore, sessionStore: store }),
		},
		events: { ...sink, onBroadcastRollback },
	}
}

function buildAssignments(
	sourceSessionId: SessionId,
	projectId: ProjectId,
	threadId: ThreadId,
	recipients: ActorRef[],
	broadcastId = 'bc_integration',
	expectedOwnerVersion = 0,
): HandoffAssignment[] {
	return recipients.map((recipientActor) => ({
		id: generateHandoffId(),
		mode: 'broadcast' as const,
		sourceSessionId,
		tenantId: DEFAULT_TENANT,
		threadId,
		projectId,
		sourceActor: userActor('usr_source'),
		recipientActor,
		expectedOwnerVersion,
		broadcastId,
		createdAt: new Date('2026-04-17'),
	}))
}

describe('Integration — broadcast handoff E2E', () => {
	it('happy: 3-recipient fan-out → each recipient has isolated worktree + source reaches awaiting_merge', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'bc-happy' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'bc-happy' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)

		// Track each `worktree add` call so we can assert each recipient got a
		// distinct worktree path (isolation).
		const addCalls: string[] = []
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				// args contains ['-C', ..., 'worktree', 'add', '-b', branch, path].
				const path = args[args.length - 1]
				if (typeof path === 'string') addCalls.push(path)
			}
			return okExec()
		}
		const { deps } = buildDeps(store, threadStore, exec)

		const recipients = [userActor('usr_bob'), userActor('usr_carol'), userActor('usr_dan')]
		const assignments = buildAssignments(source.id, project.id, thread.id, recipients)

		const outcomes = await executeBroadcastHandoff(deps, assignments, DEFAULT_TENANT)
		expect(outcomes).toHaveLength(3)
		expect(new Set(outcomes.map((o) => o.newSessionId)).size).toBe(3)
		expect(new Set(outcomes.map((o) => o.workspaceId)).size).toBe(3)

		// Each recipient landed on a distinct worktree path — isolation holds.
		expect(new Set(addCalls).size).toBe(3)

		// §5.4: source transitions to awaiting_merge post-commit.
		const reloaded = await store.getSession(source.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('awaiting_merge')

		// Three children visible via getChildren.
		const children = await store.getChildren(source.id, DEFAULT_TENANT)
		expect(children).toHaveLength(3)
		expect(children.every((c) => c.kind === 'user_handoff')).toBe(true)
	})

	it('rollback on 2nd-recipient provisioning failure: zero orphan records, partialState accurate', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'bc-rb' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'bc-rb' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)

		let addCount = 0
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				addCount += 1
				if (addCount === 2) throw new Error('simulated fault on 2nd recipient')
			}
			return okExec()
		}
		const { deps, events } = buildDeps(store, threadStore, exec)

		const assignments = buildAssignments(source.id, project.id, thread.id, [
			userActor('usr_b'),
			userActor('usr_c'),
			userActor('usr_d'),
		])

		await expect(executeBroadcastHandoff(deps, assignments, DEFAULT_TENANT)).rejects.toThrow(
			/Workspace backend git-worktree failed on create/,
		)

		// Phase 8 closed the Known Delta: rollback now calls deleteSubSession +
		// deleteSession rather than flipping to 'archived'. Zero orphan
		// sub-session records remain.
		const children = await store.getChildren(source.id, DEFAULT_TENANT)
		expect(children).toHaveLength(0)

		// Source reverted to idle with original ownerVersion.
		const reloaded = await store.getSession(source.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)

		// onBroadcastRollback emitted with accurate counts.
		expect(events.onBroadcastRollback).toHaveBeenCalledTimes(1)
		const rollbackCall = events.onBroadcastRollback.mock.calls[0]?.[0] as
			| {
					partialState: {
						worktreesProvisioned: number
						subsessionsCreated: number
						assignmentsWritten: number
					}
			  }
			| undefined
		expect(rollbackCall?.partialState.worktreesProvisioned).toBe(1)
		expect(rollbackCall?.partialState.subsessionsCreated).toBe(1)
		expect(rollbackCall?.partialState.assignmentsWritten).toBe(1)
	})

	it('source transitions to awaiting_merge + retains currentActor as coordinator (§5.4)', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'coord' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'coord' },
			DEFAULT_TENANT,
		)
		const coordinator = userActor('usr_source')
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: coordinator },
			DEFAULT_TENANT,
		)

		const { deps } = buildDeps(store, threadStore)
		const assignments = buildAssignments(source.id, project.id, thread.id, [
			userActor('usr_b'),
			userActor('usr_c'),
		])

		await executeBroadcastHandoff(deps, assignments, DEFAULT_TENANT)

		const reloaded = await store.getSession(source.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('awaiting_merge')
		// Coordinator retained as current actor (§5.4).
		expect(reloaded?.currentActor).toEqual(coordinator)
		expect(reloaded?.ownerVersion).toBe(1)
	})

	it('all recipients get isolated worktrees — zero path collisions even under N=8', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'iso' },
			DEFAULT_TENANT,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'iso' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor('usr_source') },
			DEFAULT_TENANT,
		)

		const seenPaths = new Set<string>()
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('add')) {
				const path = args[args.length - 1]
				if (typeof path === 'string') {
					if (seenPaths.has(path)) throw new Error(`path collision: ${path}`)
					seenPaths.add(path)
				}
			}
			return okExec()
		}
		const { deps } = buildDeps(store, threadStore, exec)

		const recipients = Array.from({ length: 8 }, (_, i) => userActor(`usr_${i}`))
		const assignments = buildAssignments(source.id, project.id, thread.id, recipients)

		const outcomes = await executeBroadcastHandoff(deps, assignments, DEFAULT_TENANT)
		expect(outcomes).toHaveLength(8)
		expect(seenPaths.size).toBe(8)
	})
})
