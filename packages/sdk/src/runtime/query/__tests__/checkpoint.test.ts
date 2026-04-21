import { describe, expect, it } from 'vitest'
import type { RunDiskStore } from '../../../store/run/disk.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { EmergencySaveId, RunId } from '../../../types/ids/index.js'
import type { EmergencySaveData } from '../../../types/run/emergency.js'
import { CheckpointManager, projectEmergencyToCheckpoint } from '../checkpoint.js'

function makeCheckpoint(overrides: Partial<IterationCheckpoint> = {}): IterationCheckpoint {
	return {
		id: 'cp_test_a' as CheckpointId,
		runId: 'run_test' as RunId,
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
		},
		guardState: { iterationCount: 1, elapsedMs: 100 },
		createdAt: Date.now(),
		...overrides,
	}
}

function makeStoreStub(checkpoints: IterationCheckpoint[]): RunDiskStore {
	return {
		listCheckpoints: async () => checkpoints,
	} as unknown as RunDiskStore
}

describe('CheckpointManager.listEntries', () => {
	it('projects stored checkpoints to CheckpointListEntry', async () => {
		const store = makeStoreStub([
			makeCheckpoint({
				id: 'cp_a' as CheckpointId,
				iteration: 1,
				createdAt: 1000,
				messages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello' },
				],
			}),
			makeCheckpoint({
				id: 'cp_b' as CheckpointId,
				iteration: 2,
				createdAt: 2000,
				messages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello' },
					{ role: 'user', content: 'more' },
				],
			}),
		])

		const mgr = new CheckpointManager(store)
		const entries = await mgr.listEntries()

		expect(entries).toHaveLength(2)
		expect(entries[0]).toEqual({
			id: 'cp_a',
			runId: 'run_test',
			iteration: 1,
			createdAt: 1000,
			messageCount: 2,
		})
		expect(entries[1]).toEqual({
			id: 'cp_b',
			runId: 'run_test',
			iteration: 2,
			createdAt: 2000,
			messageCount: 3,
		})
	})

	it('returns empty array when no checkpoints exist', async () => {
		const mgr = new CheckpointManager(makeStoreStub([]))
		expect(await mgr.listEntries()).toEqual([])
	})

	it('does not include full checkpoint payload fields', async () => {
		const mgr = new CheckpointManager(
			makeStoreStub([
				makeCheckpoint({
					toolResultHashes: { call_x: 'hash' },
					branchStack: [{ agentId: 'a', decision: 'd', confidence: 1, timestamp: 0 }],
				}),
			]),
		)
		const [entry] = await mgr.listEntries()
		expect(entry).not.toHaveProperty('tokenUsage')
		expect(entry).not.toHaveProperty('costInfo')
		expect(entry).not.toHaveProperty('toolResultHashes')
		expect(entry).not.toHaveProperty('branchStack')
		expect(entry).not.toHaveProperty('guardState')
		expect(entry).not.toHaveProperty('messages')
	})
})

function makeEmergencyDump(overrides: Partial<EmergencySaveData> = {}): EmergencySaveData {
	return {
		id: 'esave_dump_a' as EmergencySaveId,
		runId: 'run_victim' as RunId,
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

		expect(cp.runId).toBe('run_victim')
		expect(cp.iteration).toBe(7)
		expect(cp.messages).toBe(dump.messages)
		expect(cp.tokenUsage).toBe(dump.tokenUsage)
		expect(cp.createdAt).toBe(2_500)
		expect(cp.guardState).toEqual({ iterationCount: 7, elapsedMs: 1_500 })
		expect(cp.costInfo).toEqual({
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
		})
	})

	it('derives a deterministic CheckpointId from the emergency save id', () => {
		const dump = makeEmergencyDump({ id: 'esave_xyz123' as EmergencySaveId })
		const cp1 = projectEmergencyToCheckpoint(dump)
		const cp2 = projectEmergencyToCheckpoint(dump)

		expect(cp1.id).toBe('cp_emergency_xyz123')
		expect(cp1.id).toBe(cp2.id)
	})

	it('clamps guardState.elapsedMs to 0 when savedAt precedes startedAt', () => {
		const cp = projectEmergencyToCheckpoint(makeEmergencyDump({ startedAt: 2_000, savedAt: 1_000 }))
		expect(cp.guardState.elapsedMs).toBe(0)
	})

	it('leaves optional fields (toolResultHashes, branchStack, activeNode) unset', () => {
		const cp = projectEmergencyToCheckpoint(makeEmergencyDump())
		expect(cp.toolResultHashes).toBeUndefined()
		expect(cp.branchStack).toBeUndefined()
		expect(cp.activeNode).toBeUndefined()
	})
})
