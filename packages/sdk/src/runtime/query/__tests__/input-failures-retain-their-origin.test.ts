import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createStructuredOutputTool } from '../../../tools/builtins/structuredOutput.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ToolCall } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { SessionRecordSchema } from '../../../types/session/records.js'
import type { CompletedToolRecord } from '../../../types/session/tool-execution.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'
import { recoverCompletedCalls } from '../resume-pending.js'
import { readToolExecutions } from '../tool-executions.js'
import { sessionWithCheckpoint } from './support/session.js'

const schema = z.object({ score: z.number() })
const logger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}
function response(raw = '{"score":2}', metadata?: ToolCall['metadata']): ChatCompletionResponse {
	return {
		id: 'admission-response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'output_call',
					type: 'function',
					function: { name: 'structured_output', arguments: raw },
					...(metadata ? { metadata } : {}),
				},
			],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}
function fixture(extra: Partial<ToolExecutorConfig> = {}, outputSchema: z.ZodType = schema) {
	const turnId = generateTurnId()
	const tools = new ToolManager({
		toolsets: [testToolset(createStructuredOutputTool(outputSchema))],
		messages: () => [],
	})
	const execute = vi.spyOn(tools, 'executePrepared')
	const events: SessionEventDraft[] = []
	const executor = new ToolExecutor(
		{
			tools,
			turnId,
			sessionId: generateSessionId(),
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
	return { executor, tools, execute, events }
}
const plugin = (hook: (phase: string) => PluginHookResult): PluginLifecycleManager =>
	({
		executeHooks: vi.fn(async (phase: string) => [hook(phase)]),
	}) as unknown as PluginLifecycleManager

describe('provider argument failures carry trusted admission metadata', () => {
	it.each([true, false])(
		'classifies actual JSON/schema failures (prepared: %s)',
		async (prepared) => {
			for (const [raw, expected] of [
				['{', 'invalid_json'],
				['{"score":"bad"}', 'schema_validation'],
			] as const) {
				const f = fixture()
				const candidate = response(raw)
				const preparation = prepared ? await f.executor.prepareBatchForReview(candidate) : undefined
				const batch = await f.executor.executeBatch(candidate, undefined, undefined, preparation)
				expect(batch.results[0]).toMatchObject({ isError: true, inputFailure: expected })
				expect(f.events.find((event) => event.type === 'tool_completed')).toMatchObject({
					isError: true,
					inputFailure: expected,
				})
			}
		},
	)

	it.each(['truncated', 'malformed'] as const)(
		'retains the streamed %s distinction',
		async (reason) => {
			const f = fixture()
			const candidate = response('{}', {
				inputTruncated: true,
				partialArguments: '{"score":',
				inputError: { reason, parseError: 'incomplete', length: 9, precedingLength: 0 },
			})
			const prepared = await f.executor.prepareBatchForReview(candidate)
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
			const inputFailure = reason === 'malformed' ? 'invalid_json' : 'input_truncated'
			expect(batch.results[0]).toMatchObject({ isError: true, inputFailure })
			expect(f.events.find((event) => event.type === 'tool_completed')).toMatchObject({
				inputFailure,
			})
			expect(f.execute).not.toHaveBeenCalled()
		},
	)

	it('does not turn unsafe schema output preparation into a schema mismatch', async () => {
		const transform = vi.fn(() => new Date(0))
		const f = fixture({}, schema.transform(transform))
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(transform).toHaveBeenCalledTimes(1)
		expect(f.execute).not.toHaveBeenCalled()
	})

	it('leaves an unclassified legacy preparation refusal unclassified', async () => {
		const f = fixture()
		vi.spyOn(f.tools, 'prepareExecution').mockReturnValue({
			success: false,
			result: { success: false, output: '', error: 'schema_validation Invalid JSON' },
		})
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
	})

	it('does not revalidate a successful schema transform to classify its receipt', async () => {
		const transform = vi.fn((input: { score: number }) => ({ adjusted: input.score + 1 }))
		const f = fixture({}, schema.transform(transform))
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ output: '{"adjusted":3}', isError: false })
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(transform).toHaveBeenCalledTimes(1)
	})
})

describe('host decisions do not become provider argument failures', () => {
	it('a denial replaces an invalid candidate without retaining its schema classification', async () => {
		const f = fixture()
		const candidate = response('{"score":"bad"}')
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(
			candidate,
			new Map([['output_call', 'blocked']]),
			undefined,
			prepared,
		)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty(
			'inputFailure',
		)
	})

	it('cancellation before a prepared rejection is emitted remains cancellation', async () => {
		const controller = new AbortController()
		const f = fixture({ abortSignal: controller.signal })
		const candidate = response('{')
		const prepared = await f.executor.prepareBatchForReview(candidate)
		controller.abort('stop')
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]?.output).toContain('cancelled')
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
	})

	it('does not label a cancelled legacy execution with an earlier schema failure', async () => {
		const controller = new AbortController()
		const legacy = {
			get: () => createStructuredOutputTool(schema),
			has: () => true,
			listNames: () => ['structured_output'],
			availability: () => 'active',
			execute: async () => {
				controller.abort('stop during execution')
				return { success: false, output: '', error: 'cancelled' }
			},
		} as unknown as ToolManager
		const f = fixture({ tools: legacy, abortSignal: controller.signal })
		const batch = await f.executor.executeBatch(response('{"score":"bad"}'))
		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.results[0]?.output).toContain('cancelled')
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty(
			'inputFailure',
		)
	})

	it.each(['skip', 'error', 'modify'] as const)('does not charge a pre-tool %s', async (action) => {
		const f = fixture({
			pluginManager: plugin(() =>
				action === 'modify'
					? { action, input: { score: 'host invalid' } }
					: action === 'skip'
						? { action, reason: 'host removed candidate' }
						: { action, message: 'schema_validation from host' },
			),
		})
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty(
			'inputFailure',
		)
	})

	it('a post-tool error is not a schema failure', async () => {
		const f = fixture({
			pluginManager: plugin((phase) =>
				phase === 'post_tool_use'
					? { action: 'error', message: 'schema_validation from host' }
					: { action: 'continue' },
			),
		})
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
	})

	it.each(['{"score":4}', '{"score":"still bad"}', '{'])(
		'a local repair result %s is host-owned',
		async (raw) => {
			const f = fixture({ repairToolCall: async () => ({ arguments: raw }) })
			const candidate = response('{"score":"bad"}')
			const prepared = await f.executor.prepareBatchForReview(candidate)
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
			expect(batch.results[0]).not.toHaveProperty('inputFailure')
			if (raw === '{"score":4}') expect(batch.results[0]?.isError).toBe(false)
		},
	)

	it.each(['initial', 'reprepare'] as const)(
		'suppresses a reviewer-modified candidate during %s',
		async (mode) => {
			const f = fixture()
			const changed = new Set(['output_call'])
			const before = await f.executor.prepareBatchForReview(response())
			const candidate = response('{"score":"host invalid"}')
			const prepared =
				mode === 'initial'
					? await f.executor.prepareBatchForReview(candidate, changed)
					: await f.executor.reprepareBatchForReview(candidate, before, changed)
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
			expect(batch.results[0]).toMatchObject({ isError: true })
			expect(batch.results[0]).not.toHaveProperty('inputFailure')
		},
	)
})

describe('durable completion recovery preserves only recorded classifications', () => {
	it.each(['invalid_json', 'schema_validation', 'input_truncated', undefined] as const)(
		'restores %s without re-executing or inventing a new failure',
		async (inputFailure) => {
			const session = await sessionWithCheckpoint()
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: 'output_call',
				toolName: 'structured_output',
				result: 'recorded failure',
				isError: true,
				...(inputFailure ? { inputFailure } : {}),
			})
			const recorded = (
				await readToolExecutions(session.log, session.turnId, ['output_call'])
			).records.get('output_call')
			expect(recorded?.status).toBe('completed')
			expect(recorded).toMatchObject({ result: 'recorded failure', isError: true })
			const recorder = {
				flush: async () => {},
				log: session.log,
				turnId: session.turnId,
			} as unknown as TurnRecorder
			const recovered = await recoverCompletedCalls(
				recorder,
				response().message.toolCalls ?? [],
				logger(),
			)
			const f = fixture()
			const batch = await f.executor.executeBatch(response(), undefined, recovered)
			if (inputFailure) {
				expect(recorded).toHaveProperty('inputFailure', inputFailure)
				expect(recovered.get('output_call')).toHaveProperty('inputFailure', inputFailure)
				expect(batch.results[0]).toHaveProperty('inputFailure', inputFailure)
			} else {
				expect(recorded).not.toHaveProperty('inputFailure')
				expect(recovered.get('output_call')).not.toHaveProperty('inputFailure')
				expect(batch.results[0]).not.toHaveProperty('inputFailure')
			}
			expect(f.execute).not.toHaveBeenCalled()
			expect(f.events).toHaveLength(0)
		},
	)

	it('an interrupted start cannot invent a schema classification from error-like text', async () => {
		const session = await sessionWithCheckpoint()
		await session.log.append(session.lease, {
			type: 'tool_executing',
			turnId: session.turnId,
			toolUseId: 'output_call',
			toolName: 'structured_output',
			input: { score: 'bad' },
		})
		const recorder = {
			flush: async () => {},
			log: session.log,
			turnId: session.turnId,
		} as unknown as TurnRecorder
		const recovered = await recoverCompletedCalls(
			recorder,
			response().message.toolCalls ?? [],
			logger(),
		)
		expect(recovered.get('output_call')?.result).toContain('outcome is unknown')
		expect(recovered.get('output_call')).not.toHaveProperty('inputFailure')
	})

	it('validates an optional classification without adding bytes to legacy records', async () => {
		const session = await sessionWithCheckpoint()
		const appended = await session.log.append(session.lease, {
			type: 'tool_completed',
			turnId: session.turnId,
			toolUseId: 'output_call',
			toolName: 'structured_output',
			result: 'legacy',
			isError: true,
		})
		const record = appended.record
		const serialized = JSON.stringify(record)
		expect(JSON.stringify(SessionRecordSchema.parse(record))).toBe(serialized)
		for (const inputFailure of [
			'invalid_json',
			'schema_validation',
			'input_truncated',
		] satisfies NonNullable<CompletedToolRecord['inputFailure']>[]) {
			expect(SessionRecordSchema.parse({ ...record, inputFailure })).toMatchObject({ inputFailure })
			expect(
				SessionRecordSchema.safeParse({ ...record, inputFailure, isError: false }).success,
			).toBe(false)
		}
		for (const inputFailure of ['denied', null, 1, {}, true]) {
			expect(SessionRecordSchema.safeParse({ ...record, inputFailure }).success).toBe(false)
		}
	})
})
