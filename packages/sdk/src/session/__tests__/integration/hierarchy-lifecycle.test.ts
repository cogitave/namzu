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
import type { TopicId } from '../../../types/session/ids.js'
import { TenantIsolationError } from '../../errors.js'
import { DEFAULT_TENANT, agentActor, buildHarness, userActor } from './_fixtures.js'

const TEST_THREAD_ID = '4bd72c65-bcc9-475c-8d7c-27d622df04e8' as TopicId

describe('Integration — hierarchy lifecycle', () => {
	it('creates Tenant → Project → Session → SubSession with properly branded IDs', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'p1' }, tenant)
		expect(project.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		expect(project.tenantId).toBe(tenant)

		const session = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
			},
			tenant,
		)
		expect(session.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		expect(session.projectId).toBe(project.id)
		expect(session.tenantId).toBe(tenant)
		expect(session.status).toBe('idle')
		expect(session.ownerVersion).toBe(0)
		expect(session.previousActors).toEqual([])

		const childSession = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: agentActor('b8f09df7-1720-46cf-9a2e-d63542de60d2'),
			},
			tenant,
		)
		const subSession = await store.createSubSession(
			{
				parentSessionId: session.id,
				childSessionId: childSession.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
			},
			tenant,
		)
		expect(subSession.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
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
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: userActor('e04738b9-b828-4251-9b35-bc3bc8a2adf8'),
			},
			tenant,
		)
		const childA = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: agentActor('297e7108-719e-42f6-aa3b-f3b42d1ad2c5'),
			},
			tenant,
		)
		const childB = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: agentActor('965fee81-5ea3-4efb-a75e-ed08ff17a9ec'),
			},
			tenant,
		)
		await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: childA.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('e04738b9-b828-4251-9b35-bc3bc8a2adf8'),
			},
			tenant,
		)
		await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: childB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('e04738b9-b828-4251-9b35-bc3bc8a2adf8'),
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
			'1ef9ce34-f888-4928-9659-b4f6388670a9' as Parameters<typeof store.drill>[0],
			DEFAULT_TENANT,
		)
		expect(view).toBeNull()
	})

	it('§4.3 currentActor immutable previousActors — append-only on handoff', async () => {
		const { store } = buildHarness()
		const tenant = DEFAULT_TENANT

		const project = await store.createProject({ tenantId: tenant, name: 'actors' }, tenant)
		const userA = userActor('9ce05013-3bcc-4835-86b3-15e7b9251801')
		const userB = userActor('9087e28b-e385-43ab-908e-140e46fb01a9')
		const userC = userActor('7aea217f-b4e1-4f30-854f-6bbcce0af439')

		const session = await store.createSession(
			{ topicId: TEST_THREAD_ID, projectId: project.id, currentActor: userA },
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
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
			},
			tenant,
		)
		const sB = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: userActor('9087e28b-e385-43ab-908e-140e46fb01a9'),
			},
			tenant,
		)

		// Valid edge sA → sB.
		await store.createSubSession(
			{
				parentSessionId: sA.id,
				childSessionId: sB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
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
				spawnedBy: userActor('9087e28b-e385-43ab-908e-140e46fb01a9'),
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
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
			},
			tenant,
		)
		const child = await store.createSession(
			{
				topicId: TEST_THREAD_ID,
				projectId: project.id,
				currentActor: agentActor('297e7108-719e-42f6-aa3b-f3b42d1ad2c5'),
			},
			tenant,
		)
		const sub = await store.createSubSession(
			{
				parentSessionId: parent.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor('9ce05013-3bcc-4835-86b3-15e7b9251801'),
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
			store.getProject(
				projectA.id,
				'03857320-0500-482a-85e0-add350d8ffdd' as typeof DEFAULT_TENANT,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})
})
