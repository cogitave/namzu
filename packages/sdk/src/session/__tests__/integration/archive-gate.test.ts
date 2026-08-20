/**
 * Integration — Topic archive gate enforced at session-creation ingress
 * sites (Phase 2.6).
 *
 * The Phase 2.5 commit flagged this as a known gap:
 *   > spawn and handoff paths do not yet invoke `TopicManager.requireOpen`
 *   > before creating a child session. Until they do, the archive invariant
 *   > is best-effort.
 *
 * Phase 2.6 wires `requireOpen` into `AgentManager.provisionSpawn` + both
 * handoff flows. These tests drive the archived-topic-then-attempt-creation
 * scenarios end-to-end against the real stack.
 */

import { describe, expect, it, vi } from 'vitest'
import { TopicManager } from '../../../manager/topic/lifecycle.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { AgentId, RunId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { generateHandoffId } from '../../../utils/id.js'
import { TopicArchivedError } from '../../errors.js'
import type { HandoffAssignment } from '../../handoff/assignment.js'
import { type BroadcastHandoffDeps, executeBroadcastHandoff } from '../../handoff/broadcast.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { HandoffEventSink } from '../../handoff/events.js'
import { type SingleHandoffDeps, executeSingleHandoff } from '../../handoff/single.js'
import { GitWorktreeDriver } from '../../workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import {
	DEFAULT_TENANT,
	buildAgent,
	buildDefinition,
	buildHarness,
	buildSendMessageOptions,
	buildTaskContext,
	okExec,
	seedActiveParent,
	stubLogger,
	userActor,
} from './_fixtures.js'

describe('Integration — archive gate (Phase 2.6)', () => {
	it('AgentManager spawn: rejects with TopicArchivedError when parent topic is archived', async () => {
		const harness = buildHarness()
		const { project, thread: topic, session, actor } = await seedActiveParent(harness)

		// Archive the topic via the manager so the invariant is enforced — no
		// in-flight sessions under this topic, so archive succeeds.
		await harness.store.updateSession({ ...session, status: 'idle' }, DEFAULT_TENANT)
		await harness.topicManager.archive(topic.id, DEFAULT_TENANT)
		// Flip session back to active so the spawn's capacity path reaches
		// provisionSpawn (the archive gate should still reject).
		await harness.store.updateSession({ ...session, status: 'active' }, DEFAULT_TENANT)

		harness.registry.register(buildDefinition(buildAgent('worker')))

		await expect(
			harness.manager.sendMessage(
				buildSendMessageOptions({
					agentId: 'worker',
					parentSessionId: session.id,
					projectId: project.id,
					tenantId: DEFAULT_TENANT,
					parentActor: actor,
				}),
				buildTaskContext({
					sessionId: session.id,
					projectId: project.id,
					topicId: topic.id,
					tenantId: DEFAULT_TENANT,
					parentActor: actor,
				}),
			),
		).rejects.toBeInstanceOf(TopicArchivedError)

		// Archive invariant held: no new child sessions under the archived topic.
		const underThread = await harness.store.listSessionsByTopic(topic.id, DEFAULT_TENANT)
		expect(underThread).toHaveLength(1)
		expect(underThread[0]?.id).toBe(session.id)
	})

	it('Single handoff: rejects with TopicArchivedError when topic is archived (before CAS lock)', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryTopicStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'archive-single' },
			DEFAULT_TENANT,
		)
		const topic = await threadStore.createTopic(
			{ projectId: project.id, title: 'archive-single' },
			DEFAULT_TENANT,
		)
		const sourceActor: ActorRef = {
			kind: 'user',
			userId: 'usr_source' as UserId,
			tenantId: DEFAULT_TENANT,
		}
		const session = await store.createSession(
			{ topicId: topic.id, projectId: project.id, currentActor: sourceActor },
			DEFAULT_TENANT,
		)

		// Archive the topic directly — session is idle, so archive precondition
		// holds via listSessions.
		const topicManager = new TopicManager({
			topicStore: threadStore,
			sessionStore: store,
		})
		await topicManager.archive(topic.id, DEFAULT_TENANT)

		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: async () => okExec(),
		})
		const workspaceRegistry = new WorkspaceBackendRegistry()
		workspaceRegistry.register(driver)

		const events: HandoffEventSink = {
			onLocked: vi.fn(),
			onUnlocked: vi.fn(),
			onCommitted: vi.fn(),
			onBroadcastRollback: vi.fn(),
		}
		const deps: SingleHandoffDeps = {
			store,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			// Supplied deliberately: this suite does not exercise Run fan-in, and the
			// default that used to stand in here answered `null` for every session.
			runStatus: {
				async blockingRun() {
					return null
				},
			},

			events,
			topicManager,
		}

		const assignment: HandoffAssignment = {
			id: generateHandoffId(),
			mode: 'single',
			sourceSessionId: session.id,
			tenantId: DEFAULT_TENANT,
			topicId: topic.id,
			projectId: project.id,
			sourceActor,
			recipientActor: userActor('usr_target'),
			expectedOwnerVersion: 0,
			createdAt: new Date('2026-04-19'),
		}

		await expect(executeSingleHandoff(deps, assignment, DEFAULT_TENANT)).rejects.toBeInstanceOf(
			TopicArchivedError,
		)

		// Critical: source session must still be idle (lock never acquired).
		const reloaded = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
		expect(events.onLocked).not.toHaveBeenCalled()
	})

	it('Broadcast handoff: rejects with TopicArchivedError when topic is archived (no CAS, no worktrees)', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryTopicStore()
		const project = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'archive-bc' },
			DEFAULT_TENANT,
		)
		const topic = await threadStore.createTopic(
			{ projectId: project.id, title: 'archive-bc' },
			DEFAULT_TENANT,
		)
		const source = await store.createSession(
			{
				topicId: topic.id,
				projectId: project.id,
				currentActor: userActor('usr_source'),
			},
			DEFAULT_TENANT,
		)

		const topicManager = new TopicManager({
			topicStore: threadStore,
			sessionStore: store,
		})
		await topicManager.archive(topic.id, DEFAULT_TENANT)

		let worktreeAdds = 0
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: async (_file, args) => {
				if (args.includes('add')) worktreeAdds += 1
				return okExec()
			},
		})
		const workspaceRegistry = new WorkspaceBackendRegistry()
		workspaceRegistry.register(driver)

		const events: HandoffEventSink = {
			onLocked: vi.fn(),
			onUnlocked: vi.fn(),
			onCommitted: vi.fn(),
			onBroadcastRollback: vi.fn(),
		}
		const deps: BroadcastHandoffDeps = {
			store,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			// Supplied deliberately: this suite does not exercise Run fan-in, and the
			// default that used to stand in here answered `null` for every session.
			runStatus: {
				async blockingRun() {
					return null
				},
			},

			events,
			topicManager,
		}

		const assignments: HandoffAssignment[] = [userActor('usr_b'), userActor('usr_c')].map(
			(recipientActor) => ({
				id: generateHandoffId(),
				mode: 'broadcast' as const,
				sourceSessionId: source.id,
				tenantId: DEFAULT_TENANT,
				topicId: topic.id,
				projectId: project.id,
				sourceActor: userActor('usr_source'),
				recipientActor,
				expectedOwnerVersion: 0,
				broadcastId: 'bc_archive',
				createdAt: new Date('2026-04-19'),
			}),
		)

		await expect(executeBroadcastHandoff(deps, assignments, DEFAULT_TENANT)).rejects.toBeInstanceOf(
			TopicArchivedError,
		)

		// Source never locked, no worktrees provisioned, no rollback event —
		// the archive gate short-circuited before any side-effect landed.
		const reloaded = await store.getSession(source.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
		expect(events.onLocked).not.toHaveBeenCalled()
		expect(events.onBroadcastRollback).not.toHaveBeenCalled()
		expect(worktreeAdds).toBe(0)
	})

	it('Phase 2.6 closure: post-archive spawn via AgentManager rejects (kernel ingress path gated)', async () => {
		// End-to-end proof that the production ingress path honors the
		// archive status. Direct `SessionStore.createSession` / `updateSession`
		// remain ungated at the store layer (by design — the store has no
		// cross-store awareness), so this test exercises the manager path,
		// not the store boundary.
		const harness = buildHarness()
		const { project, thread: topic, session } = await seedActiveParent(harness)

		await harness.store.updateSession({ ...session, status: 'idle' }, DEFAULT_TENANT)
		await harness.topicManager.archive(topic.id, DEFAULT_TENANT)

		// Attempt to spawn directly via context threading (bypass the fixture
		// builder to prove the gate trips from AgentManager, not from the
		// fixture).
		harness.registry.register(buildDefinition(buildAgent('leaker')))

		const childActor: ActorRef = {
			kind: 'agent',
			agentId: 'leaker' as AgentId,
			tenantId: DEFAULT_TENANT,
		}

		// Flip session to active again so capacity checks pass and the
		// archive-gate is what fails — not an earlier guard.
		await harness.store.updateSession({ ...session, status: 'active' }, DEFAULT_TENANT)

		await expect(
			harness.manager.sendMessage(
				{
					agentId: 'leaker',
					input: { messages: [], workingDirectory: '/tmp' },
					parentSessionId: session.id,
					tenantId: DEFAULT_TENANT,
					projectId: project.id,
					parentActor: childActor,
				},
				{
					parentRunId: 'run_post_archive' as RunId,
					parentAgentId: 'supervisor',
					parentAbortController: new AbortController(),
					depth: 0,
					budgetTracker: { total: 10_000, remaining: 10_000 },
					tenantId: DEFAULT_TENANT,
					topicId: topic.id,
					sessionId: session.id,
					projectId: project.id,
					parentActor: childActor,
				},
			),
		).rejects.toBeInstanceOf(TopicArchivedError)

		// The gate tripped before any observable side effect — listSessions
		// still shows only the original seeded session, not a smuggled child.
		const underThread = await harness.store.listSessionsByTopic(topic.id, DEFAULT_TENANT)
		expect(underThread).toHaveLength(1)
		expect(underThread[0]?.id).toBe(session.id)
	})
})
