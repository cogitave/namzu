import { describe, expect, it } from 'vitest'

import { StaleSessionError } from '../../../session/errors.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { Session } from '../../../types/session/entity.js'
import { InMemorySessionStore } from '../memory.js'

/**
 * `Session.ownerVersion` was documented as the CAS counter for handoff, and
 * nothing enforced it.
 *
 * Both stores overwrote unconditionally, so the only check was in the handoff
 * path — where it compared a snapshot read several awaits earlier against
 * itself. Two concurrent handoffs on one idle session both passed, both
 * provisioned a worktree, and one silently erased the other.
 *
 * The store is the arbiter now, because it is the only party that can compare
 * against the value at the instant of the write.
 */

const TENANT = 'tnt_cas' as TenantId

async function seed(): Promise<{ store: InMemorySessionStore; session: Session }> {
	const store = new InMemorySessionStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'cas' }, TENANT)
	const session = await store.createSession(
		{ topicId: 'thd_cas' as never, projectId: project.id, currentActor: null },
		TENANT,
	)
	return { store, session }
}

describe('a session write can require that nobody else wrote first', () => {
	it('accepts a write naming the version the store holds', async () => {
		const { store, session } = await seed()

		await store.updateSession({ ...session, status: 'locked' }, TENANT, session.ownerVersion)

		expect((await store.getSession(session.id, TENANT))?.status).toBe('locked')
	})

	it('refuses a write naming a version that has moved on', async () => {
		const { store, session } = await seed()

		// Somebody else takes it first.
		await store.updateSession({ ...session, ownerVersion: 1 }, TENANT, 0)

		await expect(
			store.updateSession({ ...session, status: 'locked' }, TENANT, 0),
		).rejects.toBeInstanceOf(StaleSessionError)
	})

	it('reports what the store holds, not what the caller sent', async () => {
		// The caller already knows what it sent; the useful half of the answer
		// is how far behind it is.
		const { store, session } = await seed()
		await store.updateSession({ ...session, ownerVersion: 7 }, TENANT, 0)

		await store
			.updateSession({ ...session, status: 'locked' }, TENANT, 3)
			.then(() => expect.unreachable('the stale write should have been refused'))
			.catch((err: StaleSessionError) => {
				expect(err.details.expectedVersion).toBe(3)
				expect(err.details.actualVersion).toBe(7)
			})
	})

	it('compares against the STORED version, not the payload', async () => {
		// The payload is the caller's own copy. Comparing it to itself is the
		// check the handoff path was already making and getting nothing from,
		// so a write whose payload agrees with itself must still be refused
		// when the store has moved.
		const { store, session } = await seed()
		await store.updateSession({ ...session, ownerVersion: 5 }, TENANT, 0)

		const selfConsistentButStale: Session = { ...session, ownerVersion: 2, status: 'locked' }

		await expect(store.updateSession(selfConsistentButStale, TENANT, 2)).rejects.toBeInstanceOf(
			StaleSessionError,
		)
	})

	it('writes unconditionally when no version is named', async () => {
		// The compatibility promise: every caller that existed before this
		// parameter behaves exactly as it did.
		const { store, session } = await seed()
		await store.updateSession({ ...session, ownerVersion: 9 }, TENANT, 0)

		await store.updateSession({ ...session, status: 'locked' }, TENANT)

		expect((await store.getSession(session.id, TENANT))?.status).toBe('locked')
	})

	it('lets exactly one of two concurrent writers win', async () => {
		// The defect, in the shape it actually took: two writers holding the
		// same snapshot, racing for the same session.
		const { store, session } = await seed()
		const snapshot = session.ownerVersion

		const results = await Promise.allSettled([
			store.updateSession(
				{ ...session, status: 'locked', ownerVersion: snapshot + 1 },
				TENANT,
				snapshot,
			),
			store.updateSession(
				{ ...session, status: 'locked', ownerVersion: snapshot + 1 },
				TENANT,
				snapshot,
			),
		])

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
	})
})
