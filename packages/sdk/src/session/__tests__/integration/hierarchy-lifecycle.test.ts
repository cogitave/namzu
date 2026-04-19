/**
 * Integration — Tenant → Project → Session → SubSession → Run hierarchy
 * lifecycle against a real {@link InMemorySessionStore}.
 *
 * Covers roadmap §5 invariants §4 (branded IDs), §4.3 (currentActor
 * immutability), §4.4 (sub-session status fan-in to drill), plus the
 * `drill()` navigation primitive (§14.3). Orthogonal to `e2e-spawn.test.ts`
 * (which exercises the full AgentManager spawn path); this file asserts the
 * raw store contract under direct construction.
 */

import { describe, expect, it } from 'vitest'
import type { ThreadId } from '../../../types/session/ids.js'
import { TenantIsolationError } from '../../errors.js'
import { DEFAULT_TENANT, agentActor, buildHarness, userActor } from './_fixtures.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

describe('Integration — hierarchy lifecycle', () => {
	it('creates Tenant → Project → Session → SubSession with properly branded IDs', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'p1' }, tenant)
		expect(project.id.startsWith('prj_')).toBe(true)
		expect(project.tenantId.startsWith('tnt_')).toBe(true)

		const session = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_a') },
			tenant,
		)
		expect(session.id.startsWith('ses_')).toBe(true)
		expect(session.projectId).toBe(project.id)
		expect(session.tenantId).toBe(tenant)
		expect(session.status).toBe('idle')
		expect(session.ownerVersion).toBe(0)
		expect(session.previousActors).toEqual([])

		const childSession = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_worker') },
			tenant,
		)
		const subSession = await store.createSubSession(
			{
				parentSessionId: session.id,
				childSessionId: childSession.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_a'),
			},
			tenant,
		)
		expect(subSession.id.startsWith('sub_')).toBe(true)
		expect(subSession.parentSessionId).toBe(session.id)
		expect(subSession.childSessionId).toBe(childSession.id)
		expect(subSession.kind).toBe('agent_spawn')
		expect(subSession.status).toBe('pending')
	})

	it('drill(parentSessionId) returns a SessionView with children[] and ancestry[]', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'drill' }, tenant)
		const parent = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_root') },
			tenant,
		)
		const childA = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_a') },
			tenant,
		)
		const childB = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_b') },
			tenant,
		)
		await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: childA.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_root'),
			},
			tenant,
		)
		await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: childB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_root'),
			},
			tenant,
		)

		const parentView = await store.drill(parent.id, tenant)
		expect(parentView).not.toBeNull()
		expect(parentView?.session.id).toBe(parent.id)
		expect(parentView?.children).toHaveLength(2)
		expect(parentView?.ancestry).toEqual([parent.id])

		const childAView = await store.drill(childA.id, tenant)
		expect(childAView).not.toBeNull()
		expect(childAView?.ancestry).toEqual([parent.id, childA.id])
		expect(childAView?.children).toHaveLength(0)
	})

	it('drill returns null for unknown session (deny-by-default)', async () => {
		const { store } = buildHarness()
		const view = await store.drill(
			'ses_missing' as Parameters<typeof store.drill>[0],
			DEFAULT_TENANT,
		)
		expect(view).toBeNull()
	})

	it('§4.3 currentActor immutable previousActors — append-only on handoff', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'actors' }, tenant)
		const userA = userActor('usr_a')
		const userB = userActor('usr_b')
		const userC = userActor('usr_c')

		const session = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userA },
			tenant,
		)

		// Simulate two successive handoff commits — each pushes the old actor
		// onto previousActors and increments ownerVersion.
		const firstHandoff = {
			...session,
			currentActor: userB,
			previousActors: [userA],
			ownerVersion: 1,
		}
		await store.updateSession(firstHandoff, tenant)

		const secondHandoff = {
			...firstHandoff,
			currentActor: userC,
			previousActors: [...firstHandoff.previousActors, userB],
			ownerVersion: 2,
		}
		await store.updateSession(secondHandoff, tenant)

		const reloaded = await store.getSession(session.id, tenant)
		expect(reloaded?.currentActor).toEqual(userC)
		expect(reloaded?.previousActors).toEqual([userA, userB])
		expect(reloaded?.ownerVersion).toBe(2)
	})

	it('cycle guard via AncestryCycleError: ancestry walk detects corrupted parent linkage', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'cycle' }, tenant)
		const sA = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_a') },
			tenant,
		)
		const sB = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_b') },
			tenant,
		)

		// Valid edge sA → sB.
		await store.createSubSession(
			{
				parentSessionId: sA.id,
				childSessionId: sB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_a'),
			},
			tenant,
		)
		// Corrupting edge sB → sA closes the cycle. The store layer does not
		// pre-check parent direction (the pattern doc §4.5 discusses
		// intervention DAG cycles; ancestry cycles are a store-corruption
		// detection path per session/errors.ts#AncestryCycleError).
		await store.createSubSession(
			{
				parentSessionId: sB.id,
				childSessionId: sA.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_b'),
			},
			tenant,
		)

		await expect(store.getAncestry(sB.id, tenant)).rejects.toThrow(/cycle/i)
	})

	it('SubSession pending → active → idle lifecycle', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'lifecycle' }, tenant)
		const parent = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_a') },
			tenant,
		)
		const child = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_a') },
			tenant,
		)
		const sub = await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('usr_a'),
			},
			tenant,
		)
		expect(sub.status).toBe('pending')

		// pending → active.
		await store.updateSubSession({ ...sub, status: 'active' }, tenant)
		const active = await store.getSubSession(sub.id, tenant)
		expect(active?.status).toBe('active')

		// active → idle (§5.3: no 'closed' state — sub-sessions terminate on idle).
		await store.updateSubSession({ ...sub, status: 'idle' }, tenant)
		const idle = await store.getSubSession(sub.id, tenant)
		expect(idle?.status).toBe('idle')
	})

	it('cross-tenant hierarchy access rejects via TenantIsolationError', async () => {
		const { store } = buildHarness()
		const projectA = await store.createProject(
			{ tenantId: DEFAULT_TENANT, name: 'a' },
			DEFAULT_TENANT,
		)
		await expect(
			store.getProject(projectA.id, 'tnt_other' as typeof DEFAULT_TENANT),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})
})
