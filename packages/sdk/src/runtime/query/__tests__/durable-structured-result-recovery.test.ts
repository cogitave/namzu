import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createStructuredOutputTool } from '../../../tools/builtins/structuredOutput.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { type SessionRecord, SessionRecordSchema } from '../../../types/session/records.js'
import { generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'
import { drainQuery } from '../index.js'
import { recoverCompletedCalls } from '../resume-pending.js'
import { resumeSession } from '../resume-session.js'
import { ToolExecutionCollector, readToolExecutions } from '../tool-executions.js'
import {
	heldCheckpointStore,
	memorySession,
	records,
	rewriteSession,
	sessionWithCheckpoint,
} from './support/session.js'

const logger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

const call = {
	id: 'durable-output',
	type: 'function' as const,
	function: {
		name: 'structured_output',
		arguments: '{"score":1,"text":"previous"}',
	},
}

function recorder(log: SessionLog, turnId: TurnRecorder['turnId']): TurnRecorder {
	return { log, turnId, flush: async () => {} } as unknown as TurnRecorder
}

function batchExecutor(schema: z.ZodType, extra: Partial<ToolExecutorConfig> = {}) {
	const turnId = generateTurnId()
	const tools = new ToolManager({
		toolsets: [testToolset(createStructuredOutputTool(schema))],
		messages: () => [],
	})
	const execute = vi.spyOn(tools, 'execute')
	const executePrepared = vi.spyOn(tools, 'executePrepared')
	const events: SessionEventDraft[] = []
	const executor = new ToolExecutor(
		{
			tools,
			turnId,
			sessionId: memorySession().sessionId,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...extra,
		},
		new ActivityStore(turnId, {
			enabled: false,
			trackToolCalls: false,
			trackLlmTurns: false,
		}),
		async (event) => {
			events.push(event)
		},
		logger(),
	)
	const response = {
		id: 'durable-response',
		model: 'mock',
		message: { role: 'assistant' as const, content: null, toolCalls: [call] },
		finishReason: 'tool_calls' as const,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
	return { executor, execute, executePrepared, events, response }
}

describe('durable structured completion recovery', () => {
	it('recovers full JSON beside the bounded receipt without parsing the schema or replaying the call', async () => {
		const transform = vi.fn((input: { score: number; text: string }) => ({
			...input,
			score: input.score + 1,
		}))
		const schema = z.object({ score: z.number(), text: z.string() }).transform(transform)
		const text = 'x'.repeat(2_000)
		const turns: MockTurn[] = [
			{
				toolCalls: [{ id: call.id, name: call.function.name, args: { score: 1, text } }],
			},
		]
		const params = {
			...memorySession(),
			provider: new MockLLMProvider({ turns }),
			toolsets: [],
			agentId: 'durable-recovery',
			agentName: 'Durable recovery',
			messages: [{ role: 'user' as const, content: 'Return the structured result.' }],
			workingDirectory: process.cwd(),
			turnId: generateTurnId(),
			turnConfig: {
				model: 'mock',
				tokenBudget: 100_000,
				timeoutMs: 10_000,
				maxIterations: 4,
			},
			structuredOutput: {
				schema,
				toolResultRetention: 'durable' as const,
				maxRetries: 0,
			},
			maxToolOutputChars: 100,
			reviewAllowedCalls: () => true,
			resumeHandler: async () => ({ action: 'approve_tools' as const }),
		}
		const original = await drainQuery(params)
		expect(original.structuredOutput).toEqual({ score: 2, text })
		expect(transform).toHaveBeenCalledOnce()
		// Keep the real completion but lose the batch's history commit and settlement.
		const interrupted = await rewriteSession(params.sessionLog, [params], (draft) => draft, {
			through: (draft) => draft.type === 'tool_completed' && draft.toolUseId === call.id,
		})
		const completion = (await records(interrupted)).find(
			(record) => record.type === 'tool_completed' && record.toolUseId === call.id,
		)
		expect(completion).toMatchObject({
			structuredResultJson: JSON.stringify({ score: 2, text }),
			outputTruncated: true,
			isError: false,
		})
		if (completion?.type !== 'tool_completed') throw new Error('Missing actual completion.')
		expect(completion.result.length).toBeLessThanOrEqual(100)
		expect(() => JSON.parse(completion.result)).toThrow()
		const snapshot = await readToolExecutions(interrupted, params.turnId, [call.id])
		expect(snapshot.complete).toBe(true)
		expect(snapshot.records.get(call.id)).toMatchObject({
			result: completion.result,
			structuredResultJson: completion.structuredResultJson,
		})
		const recovered = await recoverCompletedCalls(
			recorder(interrupted, params.turnId),
			[call],
			logger(),
		)
		const f = batchExecutor(schema)
		const batch = await f.executor.executeBatch(f.response, undefined, recovered)
		expect(batch.results[0]).toMatchObject({
			output: completion.result,
			structuredResultJson: completion.structuredResultJson,
		})
		expect(batch.messages[0]).toMatchObject({
			role: 'tool',
			content: completion.result,
		})
		expect(batch.messages[0]).not.toHaveProperty('structuredResultJson')
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.executePrepared).not.toHaveBeenCalled()
		expect(f.events).toEqual([])
		expect(transform).toHaveBeenCalledOnce()

		// A recovered execution candidate is not an accepted final result. Resume
		// retains the existing fresh-inference and review contract.
		const review = vi.fn(() => ({ accept: true as const }))
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ name: 'structured_output', args: { score: 8, text: 'fresh' } }],
				},
			],
		})
		const events: SessionEvent[] = []
		const resumed = await resumeSession({
			...params,
			scope: params,
			sessionLog: interrupted,
			checkpointStore: await heldCheckpointStore(interrupted),
			provider,
			structuredOutput: { ...params.structuredOutput, review },
			pendingDecision: { action: 'approve_tools' },
			listener: (event) => {
				events.push(event)
			},
		})
		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) throw new Error('The interrupted completion did not resume.')
		expect(resumed.turn.structuredOutput).toEqual({ score: 9, text: 'fresh' })
		expect(provider.requests).toHaveLength(1)
		expect(review).toHaveBeenCalledOnce()
		expect(review).toHaveBeenCalledWith({ score: 9, text: 'fresh' }, expect.anything())
		expect(transform).toHaveBeenCalledTimes(2)
		expect(provider.requests[0]?.messages.filter((message) => message.role === 'tool')).toEqual([
			expect.objectContaining({
				content: completion.result,
				toolCallId: call.id,
			}),
		])
		expect(
			events.filter((event) => event.type === 'tool_completed' && event.toolUseId === call.id),
		).toEqual([])
		expect(
			(await records(interrupted)).filter(
				(record) => record.type === 'tool_completed' && record.toolUseId === call.id,
			),
		).toHaveLength(1)
	})

	it('keeps legacy completion bytes and receipt-only recovery unchanged', async () => {
		const session = await sessionWithCheckpoint()
		const record = (
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: call.id,
				toolName: call.function.name,
				result: '{"score":1, [legacy truncated receipt]',
				isError: false,
			})
		).record
		if (record.type !== 'tool_completed') throw new Error('Missing legacy completion.')
		expect(JSON.stringify(SessionRecordSchema.parse(record))).toBe(JSON.stringify(record))
		const recovered = await recoverCompletedCalls(
			recorder(session.log, session.turnId),
			[call],
			logger(),
		)
		expect(recovered.get(call.id)).toEqual({
			result: record.result,
			isError: false,
		})
		const f = batchExecutor(z.object({ score: z.number() }))
		const batch = await f.executor.executeBatch(f.response, undefined, recovered)
		expect(batch.results[0]).not.toHaveProperty('structuredResultJson')
		expect(batch.results[0]?.output).toBe(record.result)
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.executePrepared).not.toHaveBeenCalled()
	})

	it('refuses malformed or contradictory durable markers at the record and collector boundaries', async () => {
		const session = await sessionWithCheckpoint()
		const record = (
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: call.id,
				toolName: call.function.name,
				result: 'Bounded receipt.',
				isError: false,
				structuredResultJson: '{"score":1}',
			})
		).record
		for (const invalid of [
			...['{truncated', null, {}, '1e1000'].map((structuredResultJson) => ({
				...record,
				structuredResultJson,
			})),
			{ ...record, toolName: 'some_other_tool' },
			{ ...record, isError: true },
			{ ...record, skipped: true },
			{ ...record, isError: true, inputFailure: 'schema_validation' },
			{ ...record, via: { tool: 'code', toolUseId: 'parent_call' } },
		]) {
			expect(SessionRecordSchema.safeParse(invalid).success).toBe(false)
			const collector = new ToolExecutionCollector(session.turnId, [call.id])
			expect(() => collector.accept(invalid as unknown as SessionRecord)).toThrow()
		}
	})

	it('treats damaged candidate evidence as unknown and never replays the owned call', async () => {
		const session = await sessionWithCheckpoint()
		const beginning = (await records(session.log)).find((record) => record.type === 'turn_started')
		if (!beginning) throw new Error('Missing turn beginning.')
		const bad = {
			...beginning,
			type: 'tool_completed',
			toolUseId: call.id,
			toolName: call.function.name,
			result: 'Bounded receipt.',
			isError: false,
			structuredResultJson: '{truncated',
		} as unknown as SessionRecord
		// A custom host log must also fail closed when it yields unchecked records.
		const log = {
			read: async function* () {
				yield { record: beginning }
				yield { record: bad }
				return { intact: true, tornBytes: 0 }
			},
		} as unknown as SessionLog
		await expect(readToolExecutions(log, session.turnId, [call.id])).rejects.toThrow()
		const recovered = await recoverCompletedCalls(recorder(log, session.turnId), [call], logger())
		expect(recovered.get(call.id)).toMatchObject({ isError: true })
		expect(recovered.get(call.id)?.result).toContain('outcome is unknown')
		expect(recovered.get(call.id)).not.toHaveProperty('structuredResultJson')
		const f = batchExecutor(z.object({ score: z.number() }))
		const batch = await f.executor.executeBatch(f.response, undefined, recovered)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('structuredResultJson')
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.executePrepared).not.toHaveBeenCalled()
	})

	it('invalidates an older candidate at a later start and keeps the latest receipt without stale JSON', async () => {
		const session = await sessionWithCheckpoint()
		await session.log.append(session.lease, {
			type: 'tool_completed',
			turnId: session.turnId,
			toolUseId: call.id,
			toolName: call.function.name,
			result: 'Previous preview.',
			isError: false,
			structuredResultJson: '{"score":1}',
		})
		await session.log.append(session.lease, {
			type: 'tool_executing',
			turnId: session.turnId,
			toolUseId: call.id,
			toolName: call.function.name,
			input: {},
		})
		expect(
			(await readToolExecutions(session.log, session.turnId, [call.id])).records.get(call.id),
		).toEqual({
			toolUseId: call.id,
			toolName: call.function.name,
			status: 'started',
		})
		const unknown = await recoverCompletedCalls(
			recorder(session.log, session.turnId),
			[call],
			logger(),
		)
		expect(unknown.get(call.id)).toMatchObject({ isError: true })
		expect(unknown.get(call.id)).not.toHaveProperty('structuredResultJson')
		await session.log.append(session.lease, {
			type: 'tool_completed',
			turnId: session.turnId,
			toolUseId: call.id,
			toolName: call.function.name,
			result: 'Latest failure.',
			isError: true,
		})
		const latest = await recoverCompletedCalls(
			recorder(session.log, session.turnId),
			[call],
			logger(),
		)
		expect(latest.get(call.id)).toEqual({
			result: 'Latest failure.',
			isError: true,
		})
	})
})
