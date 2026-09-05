import { describe, expect, it } from 'vitest'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { EmergencySaveId, RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { EmergencySaveData } from '../../../types/run/emergency.js'
import type { ProjectId } from '../../../types/session/ids.js'
import { generateEmergencySaveId } from '../../../utils/id.js'
import { CheckpointManager, projectEmergencyToCheckpoint } from '../checkpoint.js'

const TEST_SCOPE: CheckpointRunScope = {
	tenantId: 'a8e039fb-e8d3-4206-9ed8-4cb17d5d8222' as TenantId,
	projectId: '08c9b09c-4412-478c-878b-dc94927c760f' as ProjectId,
	sessionId: 'fea5c0c7-1d0f-46cc-9844-c3a8f90afede' as SessionId,
	runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as RunId,
}

function makeCheckpoint(overrides: Partial<IterationCheckpoint> = {}): IterationCheckpoint {
	return {
		id: 'f627471b-ebe8-4887-90de-f6b94301d7ba' as CheckpointId,
		runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as RunId,
		iteration: 1,
		messages: [{ role: 'user', content: 'hello' }],
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: {
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
			unpricedTokens: 0,
		},
		guardState: { iterationCount: 1, elapsedMs: 100 },
		createdAt: Date.now(),
		...overrides,
	}
}

function makeStoreStub(checkpoints: IterationCheckpoint[]): CheckpointStore {
	return {
		listCheckpoints: async () => checkpoints,
	} as unknown as CheckpointStore
}

describe('CheckpointManager.listEntries', () => {
	it('projects stored checkpoints to CheckpointListEntry', async () => {
		const store = makeStoreStub([
			makeCheckpoint({
				id: 'a705a249-5a8d-47b0-9d06-f4b18cb741fe' as CheckpointId,
				iteration: 1,
				createdAt: 1000,
				messages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello' },
				],
			}),
			makeCheckpoint({
				id: '97fe065e-1670-458c-be39-9243fcf7e783' as CheckpointId,
				iteration: 2,
				createdAt: 2000,
				messages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello' },
					{ role: 'user', content: 'more' },
				],
			}),
		])

		const mgr = new CheckpointManager(store, TEST_SCOPE)
		const entries = await mgr.listEntries()

		expect(entries).toHaveLength(2)
		expect(entries[0]).toEqual({
			id: 'a705a249-5a8d-47b0-9d06-f4b18cb741fe',
			runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
			iteration: 1,
			createdAt: 1000,
			messageCount: 2,
		})
		expect(entries[1]).toEqual({
			id: '97fe065e-1670-458c-be39-9243fcf7e783',
			runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
			iteration: 2,
			createdAt: 2000,
			messageCount: 3,
		})
	})

	it('returns empty array when no checkpoints exist', async () => {
		const mgr = new CheckpointManager(makeStoreStub([]), TEST_SCOPE)
		expect(await mgr.listEntries()).toEqual([])
	})

	it('does not include full checkpoint payload fields', async () => {
		const mgr = new CheckpointManager(
			makeStoreStub([makeCheckpoint({ toolResultHashes: { call_x: 'hash' } })]),
			TEST_SCOPE,
		)
		const [entry] = await mgr.listEntries()
		expect(entry).not.toHaveProperty('tokenUsage')
		expect(entry).not.toHaveProperty('costInfo')
		expect(entry).not.toHaveProperty('toolResultHashes')
		expect(entry).not.toHaveProperty('guardState')
		expect(entry).not.toHaveProperty('messages')
	})
})

function makeEmergencyDump(overrides: Partial<EmergencySaveData> = {}): EmergencySaveData {
	return {
		id: '62a8dfef-4bd6-467b-ab11-4c4003b62ac9' as EmergencySaveId,
		runId: 'e57e7d3d-2047-411e-b876-29615951227a' as RunId,
		messages: [
			{ role: 'user', content: 'before the crash' },
			{ role: 'assistant', content: 'working' },
		],
		tokenUsage: {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		currentIteration: 7,
		startedAt: 1_000,
		savedAt: 2_500,
		processSignal: 'SIGTERM',
		...overrides,
	}
}

describe('projectEmergencyToCheckpoint', () => {
	it('produces an IterationCheckpoint with all required fields', () => {
		const dump = makeEmergencyDump()
		const cp = projectEmergencyToCheckpoint(dump)

		expect(cp.runId).toBe('e57e7d3d-2047-411e-b876-29615951227a')
		expect(cp.iteration).toBe(7)
		expect(cp.messages).toBe(dump.messages)
		expect(cp.tokenUsage).toBe(dump.tokenUsage)
		expect(cp.createdAt).toBe(2_500)
		expect(cp.guardState).toEqual({ iterationCount: 7, elapsedMs: 1_500 })
		// The projection cannot know what the pre-crash tokens cost, and it now
		// says so instead of saying they cost nothing. `{ ...ZERO_COST }` here
		// was a run that had spent real money coming back as one that had
		// spent none — and, because `ZERO_COST` is byte-identical to a total
		// nothing has been added to, it also made the next accumulation adopt
		// its own rate card as covering the pre-crash spend.
		expect(cp.costInfo).toEqual({
			totalCost: 0,
			cacheDiscount: 0,
			unpricedTokens: dump.tokenUsage.totalTokens,
		})
		expect(cp.costInfo.unpricedTokens).toBeGreaterThan(0)
	})

	it('derives a deterministic CheckpointId from the emergency save id', () => {
		const dump = makeEmergencyDump({
			id: 'eceea0d8-4d0e-4123-b812-f7a9349ea05c' as EmergencySaveId,
		})
		const cp1 = projectEmergencyToCheckpoint(dump)
		const cp2 = projectEmergencyToCheckpoint(dump)

		expect(cp1.id).toBe(dump.id)
		expect(cp1.id).toBe(cp2.id)
	})

	it('preserves the opaque key when the same emergency dump is projected again', () => {
		const dump = makeEmergencyDump({ id: generateEmergencySaveId() })
		const first = projectEmergencyToCheckpoint(dump)
		const reopened = projectEmergencyToCheckpoint(JSON.parse(JSON.stringify(dump)))
		expect(first.id).toBe(dump.id)
		expect(reopened.id).toBe(first.id)
	})

	it('clamps guardState.elapsedMs to 0 when savedAt precedes startedAt', () => {
		const cp = projectEmergencyToCheckpoint(makeEmergencyDump({ startedAt: 2_000, savedAt: 1_000 }))
		expect(cp.guardState.elapsedMs).toBe(0)
	})

	it('leaves the optional tool-result hashes unset', () => {
		const cp = projectEmergencyToCheckpoint(makeEmergencyDump())
		expect(cp.toolResultHashes).toBeUndefined()
	})
})
