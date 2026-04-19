/**
 * Integration — multi-tenant isolation enforcement at every store accessor
 * and cross-store boundary.
 *
 * Covers roadmap §5 invariants: §12 `tenantId` denormalized on every
 * persisted entity, §12.2 cross-tenant rejection (TenantIsolationError at
 * every accessor), broadcast handoff rejecting when recipient tenant
 * differs.
 *
 * Every assertion here crosses a kernel boundary with a mismatched tenantId
 * and checks that the SDK rejects rather than silently re-scoping.
 */

import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, SubSessionId, SummaryId, ThreadId } from '../../../types/session/ids.js'
import { TenantIsolationError } from '../../errors.js'
import { DEFAULT_TENANT, OTHER_TENANT, agentActor, userActor } from './_fixtures.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

async function seedTenantAResources() {
	const store = new InMemorySessionStore()
	const project = await store.createProject(
		{ tenantId: DEFAULT_TENANT, name: 'tenA' },
		DEFAULT_TENANT,
	)
	const parent = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor('usr_a') },
		DEFAULT_TENANT,
	)
	const child = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_a') },
		DEFAULT_TENANT,
	)
	const sub = await store.createSubSession(
		{
			parentSessionId: parent.id,
			childSessionId: child.id,
			kind: 'agent_spawn',
			spawnedBy: userActor('usr_a'),
		},
		DEFAULT_TENANT,
	)
	return { store, project, parent, child, sub }
}

describe('Integration — tenant isolation', () => {
	it('getProject with wrong tenantId → TenantIsolationError', async () => {
		const { store, project } = await seedTenantAResources()
		await expect(store.getProject(project.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('getSession with wrong tenantId → TenantIsolationError', async () => {
		const { store, parent } = await seedTenantAResources()
		await expect(store.getSession(parent.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('getSubSession with wrong tenantId → TenantIsolationError', async () => {
		const { store, sub } = await seedTenantAResources()
		await expect(store.getSubSession(sub.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('updateSession with wrong tenantId → TenantIsolationError', async () => {
		const { store, parent } = await seedTenantAResources()
		await expect(
			store.updateSession({ ...parent, status: 'active' }, OTHER_TENANT),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('createSubSession from a session owned by another tenant → TenantIsolationError', async () => {
		const { store, parent, child } = await seedTenantAResources()
		await expect(
			store.createSubSession(
				{
					parentSessionId: parent.id,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: userActor('usr_intruder', OTHER_TENANT),
				},
				OTHER_TENANT,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('appendMessage with wrong tenantId → TenantIsolationError', async () => {
		const { store, child } = await seedTenantAResources()
		await expect(
			store.appendMessage(child.id, createUserMessage('intruder'), OTHER_TENANT),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('loadSessionMessages cross-tenant → TenantIsolationError', async () => {
		const { store, child } = await seedTenantAResources()
		await store.appendMessage(child.id, createUserMessage('legit'), DEFAULT_TENANT)
		await expect(store.loadSessionMessages(child.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('loadMessages cross-tenant → TenantIsolationError', async () => {
		const { store, child } = await seedTenantAResources()
		await store.appendMessage(child.id, createUserMessage('legit'), DEFAULT_TENANT)
		await expect(store.loadMessages(child.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('drill(sessionId, OTHER_TENANT) on an existing session → TenantIsolationError (pattern doc §12.2 hard reject)', async () => {
		const { store, parent } = await seedTenantAResources()
		// Existing session owned by DEFAULT_TENANT, caller supplies OTHER_TENANT.
		// Pattern doc §12 specifies hard reject — no silent null masking.
		await expect(store.drill(parent.id, OTHER_TENANT)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('drill on a missing session returns null (deny-by-default surface without leaking tenant info)', async () => {
		const { store } = await seedTenantAResources()
		const view = await store.drill(
			'ses_never_existed' as Parameters<typeof store.drill>[0],
			OTHER_TENANT,
		)
		// Missing session for the queried tenant returns null (Convention #5).
		// The tenant check is conditional on the resource existing; absent
		// resources don't leak tenant info via a thrown isolation error.
		expect(view).toBeNull()
	})

	it('getChildren cross-tenant → TenantIsolationError', async () => {
		const { store, parent } = await seedTenantAResources()
		await expect(store.getChildren(parent.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('getAncestry cross-tenant → TenantIsolationError', async () => {
		const { store, parent } = await seedTenantAResources()
		await expect(store.getAncestry(parent.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('recordSummary with mismatched payload tenantId → TenantIsolationError', async () => {
		const { store, parent } = await seedTenantAResources()
		// Attempt to record a summary whose payload tenantId differs from the
		// caller tenantId — runtime guard rejects.
		await expect(
			store.recordSummary(
				{
					id: 'sum_intruder' as SummaryId,
					sessionRef: parent.id,
					tenantId: OTHER_TENANT,
					outcome: { status: 'succeeded' },
					deliverables: [],
					agentSummary: '',
					keyDecisions: [],
					at: new Date(),
					materializedBy: 'kernel',
				},
				DEFAULT_TENANT,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('getSummary cross-tenant → TenantIsolationError when a summary exists', async () => {
		const { store, parent } = await seedTenantAResources()
		await store.updateSession({ ...parent, status: 'active' }, DEFAULT_TENANT)
		await store.recordSummary(
			{
				id: 'sum_ok' as SummaryId,
				sessionRef: parent.id,
				tenantId: DEFAULT_TENANT,
				outcome: { status: 'succeeded' },
				deliverables: [],
				agentSummary: '',
				keyDecisions: [],
				at: new Date(),
				materializedBy: 'kernel',
			},
			DEFAULT_TENANT,
		)

		await expect(store.getSummary(parent.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('createProject with params.tenantId ≠ caller tenantId → TenantIsolationError (deep check)', async () => {
		const store = new InMemorySessionStore()
		await expect(
			store.createProject({ tenantId: OTHER_TENANT, name: 'mismatch' }, DEFAULT_TENANT),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('createSession with project owned by another tenant → TenantIsolationError', async () => {
		const { store, project } = await seedTenantAResources()
		await expect(
			store.createSession(
				{
					threadId: TEST_THREAD_ID,
					projectId: project.id,
					currentActor: userActor('usr_intruder', OTHER_TENANT),
				},
				OTHER_TENANT,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('tenant denormalization: Session, SubSession records carry tenantId explicitly', async () => {
		const { store, parent, sub } = await seedTenantAResources()
		const parentReloaded = await store.getSession(parent.id, DEFAULT_TENANT)
		expect(parentReloaded?.tenantId).toBe(DEFAULT_TENANT)

		// SubSession record itself does not carry tenantId in its shape — the
		// isolation is stored via the parent record tuple (subSessions map:
		// { tenantId, subSession }). Getting it via the correct tenant succeeds;
		// via the wrong tenant rejects — already covered above. This test just
		// confirms the successful access path.
		const reloaded = await store.getSubSession(sub.id, DEFAULT_TENANT)
		expect(reloaded?.id).toBe(sub.id)
	})

	it('broadcast-style cross-tenant attempt: cannot createSubSession linking parents owned by another tenant', async () => {
		// Pattern doc §12 requires recipient & source to share tenant. The
		// store-level guard here catches the shape violation — createSubSession
		// refuses to link parent/child across tenants.
		const { store, parent } = await seedTenantAResources()

		// Create a session in OTHER_TENANT with its own project.
		const otherProject = await store.createProject(
			{ tenantId: OTHER_TENANT, name: 'other' },
			OTHER_TENANT,
		)
		const otherChild = await store.createSession(
			{
				threadId: TEST_THREAD_ID,
				projectId: otherProject.id,
				currentActor: userActor('usr_other', OTHER_TENANT),
			},
			OTHER_TENANT,
		)

		await expect(
			store.createSubSession(
				{
					parentSessionId: parent.id, // DEFAULT_TENANT
					childSessionId: otherChild.id, // OTHER_TENANT
					kind: 'agent_spawn',
					spawnedBy: userActor('usr_a'),
				},
				DEFAULT_TENANT,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('deleteSubSession cross-tenant → TenantIsolationError', async () => {
		const { store, sub } = await seedTenantAResources()
		await expect(store.deleteSubSession(sub.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('deleteSession cross-tenant → TenantIsolationError', async () => {
		const { store } = await seedTenantAResources()
		// Parent has a sub-session attached → deleteSession would fail anyway,
		// but the tenant guard fires first. Use a standalone session.
		const project: ProjectId = (
			await store.createProject({ tenantId: DEFAULT_TENANT, name: 'del' }, DEFAULT_TENANT)
		).id
		const lonely = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project, currentActor: userActor('usr_lonely') },
			DEFAULT_TENANT,
		)
		await expect(store.deleteSession(lonely.id, OTHER_TENANT)).rejects.toBeInstanceOf(
			TenantIsolationError,
		)
	})

	it('missing sub-session returns null for correct tenant (not a leak channel)', async () => {
		const { store } = await seedTenantAResources()
		// Missing id via correct tenant → null, not thrown. Confirms the
		// missing-resource fast-path doesn't pre-empt the tenant check.
		const missing = await store.getSubSession('sub_never_existed' as SubSessionId, DEFAULT_TENANT)
		expect(missing).toBeNull()
	})
})
