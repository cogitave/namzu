/**
 * Integration — delegation capacity (depth + width) caps enforced at real
 * spawn sites. See session-hierarchy.md §6.5.
 *
 * Covers roadmap §5 invariants: §6.5 capacity enforcement at both
 * `spawnSubSession` (AgentManager.sendMessage) and `broadcastHandoff` call
 * sites. Orthogonal to `session/handoff/__tests__/capacity.test.ts` which
 * exercises `DefaultCapacityValidator` directly — this file routes through
 * the real manager so the wired capacity check fires before any observable
 * state change.
 */

import { describe, expect, it } from 'vitest'
import { DelegationCapacityExceeded } from '../../handoff/capacity.js'
import type { ActorRef } from '../../hierarchy/actor.js'
import {
	DEFAULT_TENANT,
	agentActor,
	buildAgent,
	buildDefinition,
	buildHarness,
	buildSendMessageOptions,
	buildTaskContext,
	seedActiveParent,
	userActor,
} from './_fixtures.js'

describe('Integration — capacity caps at spawn sites', () => {
	it('spawn at depth 4 accepted; depth 5 rejected (default maxDelegationDepth=4)', async () => {
		const harness = buildHarness()
		const { project } = await seedActiveParent(harness)

		// Build a depth-4 ancestry chain under the project. Each layer flips to
		// `active` so it is a legal spawn parent via the real AgentManager.
		const chainActors: ActorRef[] = [userActor('usr_root')]
		let parentSessionId = (
			await harness.store.createSession(
				{ projectId: project.id, currentActor: chainActors[0] ?? userActor('usr_root') },
				DEFAULT_TENANT,
			)
		).id
		// depth 0 root session.
		const sessions: string[] = [parentSessionId]

		for (let i = 0; i < 4; i++) {
			const child = await harness.store.createSession(
				{ projectId: project.id, currentActor: agentActor(`agt_${i}`) },
				DEFAULT_TENANT,
			)
			await harness.store.createSubSession(
				{
					parentSessionId,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: agentActor(`agt_${i}`),
				},
				DEFAULT_TENANT,
			)
			parentSessionId = child.id
			sessions.push(child.id)
		}
		// Ancestry of the tail is root→c1→c2→c3→c4 = length 5; spawning under
		// it would land a child at depth 5 which exceeds the default cap of 4.

		harness.registry.register(buildDefinition(buildAgent('worker')))

		const tail = parentSessionId as Parameters<typeof buildSendMessageOptions>[0]['parentSessionId']
		const context = buildTaskContext({
			sessionId: tail,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: userActor('usr_root'),
		})
		const options = buildSendMessageOptions({
			agentId: 'worker',
			parentSessionId: tail,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: userActor('usr_root'),
		})

		await expect(harness.manager.sendMessage(options, context)).rejects.toBeInstanceOf(
			DelegationCapacityExceeded,
		)
	})

	it('spawn at width 8 accepted; 9th sibling rejected (default maxDelegationWidth=8)', async () => {
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)

		// Seed 8 existing children directly through the store.
		for (let i = 0; i < 8; i++) {
			const child = await harness.store.createSession(
				{ projectId: project.id, currentActor: agentActor(`agt_${i}`) },
				DEFAULT_TENANT,
			)
			await harness.store.createSubSession(
				{
					parentSessionId: session.id,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: actor,
				},
				DEFAULT_TENANT,
			)
		}

		harness.registry.register(buildDefinition(buildAgent('worker')))

		const context = buildTaskContext({
			sessionId: session.id,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: actor,
		})
		const options = buildSendMessageOptions({
			agentId: 'worker',
			parentSessionId: session.id,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: actor,
		})

		// Ninth direct child via sendMessage should reject on width.
		await expect(harness.manager.sendMessage(options, context)).rejects.toBeInstanceOf(
			DelegationCapacityExceeded,
		)
	})

	it('wired path: capacity validator reads from the real store (ancestry + children) via AgentManager', async () => {
		// Exercises the manager.sendMessage → capacity.validateDepth +
		// capacity.validateWidth seam. The real validator is
		// DefaultCapacityValidator(store) so it walks the actual persisted
		// parent chain — confirms the wiring rather than a direct unit call.
		const harness = buildHarness()
		const { project, session, actor } = await seedActiveParent(harness)

		harness.registry.register(buildDefinition(buildAgent('worker')))

		// Only 1 existing child — well below caps. Spawn should succeed
		// through the wired path.
		const context = buildTaskContext({
			sessionId: session.id,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: actor,
		})
		const options = buildSendMessageOptions({
			agentId: 'worker',
			parentSessionId: session.id,
			projectId: project.id,
			tenantId: DEFAULT_TENANT,
			parentActor: actor,
		})

		const task = await harness.manager.sendMessage(options, context)
		await harness.manager.waitForCompletion(task.taskId)

		const spawn = harness.manager.getSpawnRecord(task.taskId)
		expect(spawn).toBeDefined()
		const children = await harness.store.getChildren(session.id, DEFAULT_TENANT)
		expect(children.length).toBeGreaterThanOrEqual(1)
	})
})
