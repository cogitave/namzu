import { describe, expect, it } from 'vitest'
import type { CheckpointId } from '../../../types/hitl/index.js'
import { CheckpointManager } from '../checkpoint.js'
import {
	type CheckpointedSession,
	addCheckpoint,
	checkpointRecords,
	checkpointStoreFor,
	sessionWithCheckpoint,
} from './support/session.js'

function manager(session: CheckpointedSession): CheckpointManager {
	return new CheckpointManager(checkpointRecords(session), session.store, session.scope)
}

describe('CheckpointManager.listEntries', () => {
	it('projects stored checkpoints to CheckpointListEntry', async () => {
		const session = await sessionWithCheckpoint({
			checkpointId: 'a705a249-5a8d-47b0-9d06-f4b18cb741fe' as CheckpointId,
			document: { iteration: 1, createdAt: new Date(1_000).toISOString() },
		})
		const second = await addCheckpoint(session, {
			checkpointId: '97fe065e-1670-458c-be39-9243fcf7e783' as CheckpointId,
			iteration: 2,
			createdAt: new Date(2_000).toISOString(),
		})
		const head = await session.log.head()

		const entries = await manager(session).listEntries()

		expect(entries).toHaveLength(2)
		expect(entries[0]).toMatchObject({
			id: 'a705a249-5a8d-47b0-9d06-f4b18cb741fe',
			sessionId: session.sessionId,
			turnId: session.turnId,
			iteration: 1,
			createdAt: 1_000,
		})
		expect(entries[1]).toEqual({
			id: second,
			sessionId: session.sessionId,
			turnId: session.turnId,
			iteration: 2,
			createdAt: 2_000,
			// The second checkpoint covers the log up to its own commit point.
			throughSeq: (head?.pointer.seq ?? 0) - 1,
		})
		expect(entries[0]?.throughSeq).toBeLessThan(entries[1]?.throughSeq ?? 0)
	})

	it('returns empty array when no checkpoints exist', async () => {
		const session = await sessionWithCheckpoint()
		const empty = new CheckpointManager(
			checkpointRecords(session),
			checkpointStoreFor(session.log),
			session.scope,
		)
		expect(await empty.listEntries()).toEqual([])
	})

	it('does not include full checkpoint payload fields', async () => {
		const session = await sessionWithCheckpoint()
		const [entry] = await manager(session).listEntries()
		expect(entry).not.toHaveProperty('tokenUsage')
		expect(entry).not.toHaveProperty('costInfo')
		expect(entry).not.toHaveProperty('guards')
		expect(entry).not.toHaveProperty('review')
		expect(entry).not.toHaveProperty('messages')
	})
})
