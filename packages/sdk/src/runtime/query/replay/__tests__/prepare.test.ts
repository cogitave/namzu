import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckpointId, IterationCheckpoint } from '../../../../types/hitl/index.js'
import type { EmergencySaveId, RunId, ToolCallId } from '../../../../types/ids/index.js'
import type { AssistantMessage, ToolMessage } from '../../../../types/message/index.js'
import type { EmergencySaveData } from '../../../../types/run/emergency.js'
import type { Mutation } from '../../../../types/run/replay.js'
import { prepareReplayState } from '../prepare.js'

const RUN_ID = '773652d8-a3bf-4154-b92c-322af6d773e4' as RunId

function makeCheckpoint(overrides: Partial<IterationCheckpoint>): IterationCheckpoint {
	return {
		id: '40144495-50fc-4842-9e2b-41543a128a64' as CheckpointId,
		runId: RUN_ID,
		iteration: 1,
		messages: [{ role: 'user', content: 'hi' }],
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
		guardState: { iterationCount: 1, elapsedMs: 0 },
		createdAt: Date.now(),
		...overrides,
	}
}

async function seedCheckpoint(baseDir: string, cp: IterationCheckpoint): Promise<void> {
	const cpDir = join(baseDir, cp.runId, 'checkpoints')
	await mkdir(cpDir, { recursive: true })
	await writeFile(join(cpDir, `${cp.id}.json`), JSON.stringify(cp), 'utf-8')
}

async function seedEmergency(emergencyDir: string, dump: EmergencySaveData): Promise<void> {
	await mkdir(emergencyDir, { recursive: true })
	await writeFile(join(emergencyDir, `${dump.runId}.json`), JSON.stringify(dump), 'utf-8')
}

describe('prepareReplayState', () => {
	let baseDir: string
	let emergencyDir: string

	beforeEach(async () => {
		const wrapper = await mkdtemp(join(tmpdir(), 'namzu-prepare-replay-'))
		baseDir = join(wrapper, 'runs')
		emergencyDir = join(wrapper, 'emergency')
		await mkdir(baseDir, { recursive: true })
	})

	afterEach(async () => {
		// Per-test tmpdir isolation; vitest cleans tmpdir between runs.
	})

	it('resolves a specific CheckpointId and returns the checkpoint messages', async () => {
		const cp = makeCheckpoint({
			id: '17f1fb6b-0479-40a1-bf1e-115de23b0ba3' as CheckpointId,
			iteration: 3,
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'assistant', content: 'ok' },
			],
		})
		await seedCheckpoint(baseDir, cp)

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: '17f1fb6b-0479-40a1-bf1e-115de23b0ba3' as CheckpointId,
		})

		expect(prepared.sourceCheckpoint.id).toBe('17f1fb6b-0479-40a1-bf1e-115de23b0ba3')
		expect(prepared.messages).toEqual(cp.messages)
		expect(prepared.attribution.sourceRunId).toBe(RUN_ID)
		expect(prepared.attribution.fromCheckpointId).toBe('17f1fb6b-0479-40a1-bf1e-115de23b0ba3')
		expect(prepared.attribution.mutations).toEqual([])
		expect(prepared.attribution.replayedAt).toBeGreaterThan(0)
	})

	it("resolves 'latest' to the checkpoint with the highest iteration", async () => {
		await seedCheckpoint(
			baseDir,
			makeCheckpoint({ id: 'a705a249-5a8d-47b0-9d06-f4b18cb741fe' as CheckpointId, iteration: 1 }),
		)
		await seedCheckpoint(
			baseDir,
			makeCheckpoint({ id: '97fe065e-1670-458c-be39-9243fcf7e783' as CheckpointId, iteration: 5 }),
		)
		await seedCheckpoint(
			baseDir,
			makeCheckpoint({ id: 'f7908c7d-9d45-4d5b-a8c0-11e9f59d9510' as CheckpointId, iteration: 3 }),
		)

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: 'latest',
		})

		expect(prepared.sourceCheckpoint.id).toBe('97fe065e-1670-458c-be39-9243fcf7e783')
		expect(prepared.sourceCheckpoint.iteration).toBe(5)
	})

	it("throws when 'latest' is requested but no checkpoints exist", async () => {
		await expect(
			prepareReplayState({
				baseDir,
				runId: RUN_ID,
				fromCheckpoint: 'latest',
			}),
		).rejects.toThrow(/No checkpoints found/)
	})

	it('throws when a specific CheckpointId does not resolve', async () => {
		await expect(
			prepareReplayState({
				baseDir,
				runId: RUN_ID,
				fromCheckpoint: 'e8e27c68-a53c-4003-9fbe-3349649af71a' as CheckpointId,
			}),
		).rejects.toThrow(/not found/)
	})

	it('applies injectToolResponse mutations at the fork point', async () => {
		const assistantMsg: AssistantMessage = {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'noop', arguments: '{}' } }],
		}
		const cp = makeCheckpoint({
			id: '77b62568-8f82-427b-ba26-8cf13e67bece' as CheckpointId,
			messages: [{ role: 'user', content: 'run tool' }, assistantMsg],
		})
		await seedCheckpoint(baseDir, cp)

		const mutations: Mutation[] = [
			{
				type: 'injectToolResponse',
				toolCallId: 'call_a' as ToolCallId,
				response: { success: true, output: 'mocked-a' },
			},
		]

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: '77b62568-8f82-427b-ba26-8cf13e67bece' as CheckpointId,
			mutate: mutations,
		})

		expect(prepared.messages).toHaveLength(3)
		const appended = prepared.messages[2] as ToolMessage
		expect(appended.role).toBe('tool')
		expect(appended.toolCallId).toBe('call_a')
		expect(appended.content).toBe('mocked-a')
		expect(prepared.attribution.mutations).toEqual(mutations)
	})

	it.each([
		['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000'],
		['5985bc78-64b1-438b-972f-96d5dc0c5af0', '5985bc78-64b1-438b-972f-96d5dc0c5af0'],
	])('resolves emergency dump %s with stable projection %s', async (emergencyId, checkpointId) => {
		const dump: EmergencySaveData = {
			id: emergencyId as EmergencySaveId,
			runId: RUN_ID,
			messages: [{ role: 'user', content: 'before crash' }],
			tokenUsage: {
				promptTokens: 4,
				completionTokens: 2,
				totalTokens: 6,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			currentIteration: 9,
			startedAt: 1_000,
			savedAt: 2_000,
			processSignal: 'SIGTERM',
		}
		await seedEmergency(emergencyDir, dump)

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: 'emergency',
			emergencyDir,
		})

		expect(prepared.sourceCheckpoint.id).toBe(checkpointId)
		expect(prepared.sourceCheckpoint.iteration).toBe(9)
		expect(prepared.messages).toEqual(dump.messages)
		expect(prepared.attribution.fromCheckpointId).toBe(checkpointId)
	})

	it("throws when 'emergency' is requested without emergencyDir", async () => {
		await expect(
			prepareReplayState({
				baseDir,
				runId: RUN_ID,
				fromCheckpoint: 'emergency',
			}),
		).rejects.toThrow(/emergencyDir/)
	})

	it("throws when 'emergency' dump file is missing", async () => {
		await expect(
			prepareReplayState({
				baseDir,
				runId: RUN_ID,
				fromCheckpoint: 'emergency',
				emergencyDir,
			}),
		).rejects.toThrow(/No emergency dump/)
	})
})
