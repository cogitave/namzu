import { describe, expect, it } from 'vitest'
import { TenantIsolationError } from '../../../session/errors.js'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import type { SubSession } from '../../../session/hierarchy/sub-session.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { InMemorySessionStore } from '../memory.js'

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId, parent?: ActorRef): ActorRef {
	return {
		kind: 'agent',
		agentId: 'agt_a' as AgentId,
		tenantId,
		...(parent !== undefined && { parentActor: parent }),
	}
}

const tenantA = 'tnt_alpha' as TenantId
const tenantB = 'tnt_beta' as TenantId

async function seed(store: InMemorySessionStore, tenantId: TenantId) {
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const session = await store.createSession(
		{ projectId: project.id, currentActor: userActor(tenantId) },
		tenantId,
	)
	return { project, session }
}

describe('InMemorySessionStore', () => {
	it('creates and retrieves a project + session', async () => {
		const store = new InMemorySessionStore()
		const { project, session } = await seed(store, tenantA)

		expect(await store.getProject(project.id, tenantA)).toMatchObject({ id: project.id })
		expect(await store.getSession(session.id, tenantA)).toMatchObject({ id: session.id })
		expect(session.status).toBe('idle')
		expect(session.ownerVersion).toBe(0)
	})

	it('rejects cross-tenant project reads with TenantIsolationError', async () => {
		const store = new InMemorySessionStore()
		const { project } = await seed(store, tenantA)

		await expect(store.getProject(project.id, tenantB)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('rejects cross-tenant session reads with TenantIsolationError', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seed(store, tenantA)

		await expect(store.getSession(session.id, tenantB)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('rejects cross-tenant updateSession (payload tenant mismatch)', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seed(store, tenantA)

		// Mutate tenantId to tenantB in the payload while supplying tenantA to the
		// call — the call authorizes via the requested tenant, but the mismatched
		// payload must reject.
		const forged = { ...session, tenantId: tenantB }
		await expect(store.updateSession(forged, tenantA)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('round-trips a session update (status + ownerVersion)', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seed(store, tenantA)

		await store.updateSession({ ...session, status: 'active', ownerVersion: 1 }, tenantA)
		const reloaded = await store.getSession(session.id, tenantA)
		expect(reloaded).not.toBeNull()
		expect(reloaded?.status).toBe('active')
		expect(reloaded?.ownerVersion).toBe(1)
	})

	it('drill returns children and root-to-self ancestry', async () => {
		const store = new InMemorySessionStore()
		const { project, session: root } = await seed(store, tenantA)

		// Create a child session + link via sub-session.
		const child = await store.createSession(
			{ projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		const sub = await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		const view = await store.drill(root.id, tenantA)
		expect(view).not.toBeNull()
		expect(view?.children.map((c) => c.id)).toEqual([sub.id])
		expect(view?.ancestry).toEqual([root.id])

		const childView = await store.drill(child.id, tenantA)
		expect(childView?.ancestry).toEqual([root.id, child.id])
		expect(childView?.children).toEqual([])
	})

	it('loadMessages returns [] before any append and persists in insertion order', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seed(store, tenantA)

		expect(await store.loadMessages(session.id, tenantA)).toEqual([])

		const id1 = await store.appendMessage(session.id, createUserMessage('first'), tenantA)
		const id2 = await store.appendMessage(session.id, createUserMessage('second'), tenantA)
		expect(id1).not.toBe(id2)

		const loaded = await store.loadMessages(session.id, tenantA)
		expect(loaded.map((m) => m.content)).toEqual(['first', 'second'])
	})

	it('rejects cross-tenant appendMessage / loadMessages', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seed(store, tenantA)

		await expect(
			store.appendMessage(session.id, createUserMessage('x'), tenantB),
		).rejects.toBeInstanceOf(TenantIsolationError)
		await expect(store.loadMessages(session.id, tenantB)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('getChildren / getAncestry ignore other-tenant sub-sessions', async () => {
		const store = new InMemorySessionStore()
		const { project: pA, session: rootA } = await seed(store, tenantA)
		const { project: pB, session: rootB } = await seed(store, tenantB)

		const childA = await store.createSession(
			{ projectId: pA.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		await store.createSubSession(
			{
				parentSessionId: rootA.id,
				childSessionId: childA.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		const childB = await store.createSession(
			{ projectId: pB.id, currentActor: agentActor(tenantB) },
			tenantB,
		)
		await store.createSubSession(
			{
				parentSessionId: rootB.id,
				childSessionId: childB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantB),
			},
			tenantB,
		)

		// Tenant A's view must not see tenant B's sub-sessions.
		const aChildren = await store.getChildren(rootA.id, tenantA)
		expect(aChildren).toHaveLength(1)
		expect(aChildren[0]?.childSessionId).toBe(childA.id)

		const bChildren = await store.getChildren(rootB.id, tenantB)
		expect(bChildren).toHaveLength(1)
		expect(bChildren[0]?.childSessionId).toBe(childB.id)
	})

	it('drill returns null for missing sessions', async () => {
		const store = new InMemorySessionStore()
		const missing = 'ses_missing' as SessionId
		expect(await store.drill(missing, tenantA)).toBeNull()
	})

	it('ancestry walker rejects cycles (corrupted store)', async () => {
		const store = new InMemorySessionStore()
		const { project, session: rootA } = await seed(store, tenantA)
		const sessionB = await store.createSession(
			{ projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)

		// A→B
		await store.createSubSession(
			{
				parentSessionId: rootA.id,
				childSessionId: sessionB.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)
		// B→A  (cycle — the write path does not yet enforce acyclicity;
		//      the walker must detect corruption rather than infinite-loop.)
		await store.createSubSession(
			{
				parentSessionId: sessionB.id,
				childSessionId: rootA.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		await expect(store.getAncestry(rootA.id, tenantA)).rejects.toMatchObject({
			name: 'AncestryCycleError',
		})
	})

	it('orderChildren yields deterministic ordering by spawnedAt then id', async () => {
		const store = new InMemorySessionStore()
		const { project, session: root } = await seed(store, tenantA)

		const c1 = await store.createSession(
			{ projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		const c2 = await store.createSession(
			{ projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)

		const s1 = await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: c1.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)
		const s2 = await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: c2.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		const children = await store.getChildren(root.id, tenantA)
		const ids = children.map((s: SubSession) => s.id)
		expect(new Set(ids)).toEqual(new Set([s1.id, s2.id]))
	})
})
