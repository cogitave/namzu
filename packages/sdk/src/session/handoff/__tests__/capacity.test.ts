import { describe, expect, it } from 'vitest'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { DefaultCapacityValidator, DelegationCapacityExceeded } from '../capacity.js'

const tenant = 'tnt_alpha' as TenantId

function user(): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId: tenant }
}

function agent(): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId: tenant }
}

async function seedProject(store: InMemorySessionStore) {
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const root = await store.createSession({ projectId: project.id, currentActor: user() }, tenant)
	return { project, root }
}

async function spawnChild(
	store: InMemorySessionStore,
	parentId: SessionId,
	projectId: ReturnType<typeof String> extends never
		? never
		: Parameters<InMemorySessionStore['createSession']>[0]['projectId'],
): Promise<{ childId: SessionId }> {
	const child = await store.createSession({ projectId, currentActor: user() }, tenant)
	await store.createSubSession(
		{
			parentSessionId: parentId,
			childSessionId: child.id,
			kind: 'agent_spawn',
			spawnedBy: agent(),
		},
		tenant,
	)
	return { childId: child.id }
}

describe('DefaultCapacityValidator', () => {
	it('depth: root session validates against limit 4 (new child would be depth 1) — passes', async () => {
		const store = new InMemorySessionStore()
		const { root } = await seedProject(store)
		const validator = new DefaultCapacityValidator(store)

		await expect(validator.validateDepth(root.id, 4, tenant)).resolves.toBeUndefined()
	})

	it('depth: chain of 4 (root→c1→c2→c3→c4) allows a 5th (depth 5) to pass when limit = 5', async () => {
		const store = new InMemorySessionStore()
		const { project, root } = await seedProject(store)
		const c1 = await spawnChild(store, root.id, project.id)
		const c2 = await spawnChild(store, c1.childId, project.id)
		const c3 = await spawnChild(store, c2.childId, project.id)
		const c4 = await spawnChild(store, c3.childId, project.id)

		const validator = new DefaultCapacityValidator(store)
		// Ancestry of c4: root→c1→c2→c3→c4 = length 5. Spawning under c4 = depth 5.
		await expect(validator.validateDepth(c4.childId, 5, tenant)).resolves.toBeUndefined()
	})

	it('depth: over-limit throws DelegationCapacityExceeded with dimension=depth', async () => {
		const store = new InMemorySessionStore()
		const { project, root } = await seedProject(store)
		const c1 = await spawnChild(store, root.id, project.id)
		const c2 = await spawnChild(store, c1.childId, project.id)
		const c3 = await spawnChild(store, c2.childId, project.id)
		const c4 = await spawnChild(store, c3.childId, project.id)

		const validator = new DefaultCapacityValidator(store)
		try {
			// Ancestry of c4 has length 5; limit=4 means depth 5 > 4 → reject.
			await validator.validateDepth(c4.childId, 4, tenant)
			expect.fail('expected DelegationCapacityExceeded')
		} catch (err) {
			expect(err).toBeInstanceOf(DelegationCapacityExceeded)
			const e = err as DelegationCapacityExceeded
			expect(e.details.dimension).toBe('depth')
			expect(e.details.limit).toBe(4)
			expect(e.details.current).toBe(5)
		}
	})

	it('width: empty parent with 4 pending children passes limit=8', async () => {
		const store = new InMemorySessionStore()
		const { root } = await seedProject(store)
		const validator = new DefaultCapacityValidator(store)

		await expect(validator.validateWidth(root.id, 4, 8, tenant)).resolves.toBeUndefined()
	})

	it('width: existing 5 + pending 3 = 8 passes exactly at the limit', async () => {
		const store = new InMemorySessionStore()
		const { project, root } = await seedProject(store)
		for (let i = 0; i < 5; i++) {
			await spawnChild(store, root.id, project.id)
		}
		const validator = new DefaultCapacityValidator(store)
		await expect(validator.validateWidth(root.id, 3, 8, tenant)).resolves.toBeUndefined()
	})

	it('width: existing 6 + pending 3 = 9 exceeds 8, throws dimension=width', async () => {
		const store = new InMemorySessionStore()
		const { project, root } = await seedProject(store)
		for (let i = 0; i < 6; i++) {
			await spawnChild(store, root.id, project.id)
		}
		const validator = new DefaultCapacityValidator(store)
		try {
			await validator.validateWidth(root.id, 3, 8, tenant)
			expect.fail('expected DelegationCapacityExceeded')
		} catch (err) {
			expect(err).toBeInstanceOf(DelegationCapacityExceeded)
			const e = err as DelegationCapacityExceeded
			expect(e.details.dimension).toBe('width')
			expect(e.details.current).toBe(9)
			expect(e.details.limit).toBe(8)
		}
	})
})
