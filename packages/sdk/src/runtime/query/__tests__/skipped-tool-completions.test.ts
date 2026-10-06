import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createStructuredOutputTool } from '../../../tools/builtins/structuredOutput.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ToolCall } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { SessionRecordSchema } from '../../../types/session/records.js'
import type { SessionRecord } from '../../../types/session/records.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'
import { skippedToolResultText } from '../plugin-hooks.js'
import { recoverCompletedCalls } from '../resume-pending.js'
import { ToolExecutionCollector, readToolExecutions } from '../tool-executions.js'
import { sessionWithCheckpoint } from './support/session.js'

const schema = z.object({ score: z.number() })
const logger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}
function response(
	raw = '{"score":2}',
	name = 'structured_output',
	metadata?: ToolCall['metadata'],
): ChatCompletionResponse {
	return {
		id: 'skipped-completion-response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'output_call',
					type: 'function',
					function: { name, arguments: raw },
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
function fixture(
	extra: Partial<ToolExecutorConfig> = {},
	registered: readonly ToolDefinition[] = [createStructuredOutputTool(schema)],
	legacyRegistry = false,
) {
	const turnId = generateTurnId()
	const tools = new ToolManager({ toolsets: [testToolset(...registered)], messages: () => [] })
	const execute = vi.spyOn(tools, 'execute')
	const executePrepared = vi.spyOn(tools, 'executePrepared')
	const registry = legacyRegistry
		? ({
				get: tools.get.bind(tools),
				has: tools.has.bind(tools),
				listNames: tools.listNames.bind(tools),
				availability: tools.availability.bind(tools),
				execute: tools.execute.bind(tools),
			} as unknown as ToolManager)
		: tools
	const events: SessionEventDraft[] = []
	const executor = new ToolExecutor(
		{
			tools: registry,
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
	return { executor, tools, execute, executePrepared, events }
}
function plugin(
	hook: (phase: string, toolName?: string) => readonly PluginHookResult[],
): PluginLifecycleManager {
	return {
		executeHooks: vi.fn(async (phase: string, context: { toolName?: string }) =>
			hook(phase, context.toolName),
		),
	} as unknown as PluginLifecycleManager
}
const skipPlugin = () =>
	plugin((phase, name) =>
		phase === 'pre_tool_use' && name === 'structured_output'
			? [{ action: 'skip', reason: 'The host deferred this output.' }]
			: [],
	)

describe('pre-tool skip completion metadata', () => {
	it.each([
		{ prepared: false, legacyRegistry: false },
		{ prepared: true, legacyRegistry: false },
		{ prepared: false, legacyRegistry: true },
		{ prepared: true, legacyRegistry: true },
	])(
		'marks a real skip without running the tool (prepared: $prepared, legacy registry: $legacyRegistry)',
		async ({ prepared, legacyRegistry }) => {
			const f = fixture({ pluginManager: skipPlugin() }, undefined, legacyRegistry)
			const candidate = response()
			const preparation = prepared ? await f.executor.prepareBatchForReview(candidate) : undefined
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, preparation)

			expect(batch.results).toEqual([
				{
					toolCallId: 'output_call',
					toolName: 'structured_output',
					output: skippedToolResultText('structured_output', 'The host deferred this output.'),
					isError: false,
					skipped: true,
				},
			])
			expect(f.events.map((event) => event.type)).toEqual(['tool_executing', 'tool_completed'])
			expect(f.events[1]).toMatchObject({ skipped: true, isError: false })
			expect(f.events[1]).not.toHaveProperty('inputFailure')
			expect(f.execute).not.toHaveBeenCalled()
			expect(f.executePrepared).not.toHaveBeenCalled()
			expect(batch.messages[0]).toMatchObject({
				role: 'tool',
				isError: false,
				content: batch.results[0]?.output,
			})
		},
	)

	it('keeps a hook-modify then skip non-error and unexecuted', async () => {
		const f = fixture({
			pluginManager: plugin((phase) =>
				phase === 'pre_tool_use'
					? [
							{ action: 'modify', input: { score: 'Not an executable candidate' } },
							{ action: 'skip', reason: 'Do not use the rewritten candidate.' },
						]
					: [],
			),
		})
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ skipped: true, isError: false })
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(f.executePrepared).not.toHaveBeenCalled()
	})

	it.each(['error', 'modify'] as const)(
		'does not mark a pre-tool %s as skipped',
		async (action) => {
			const f = fixture({
				pluginManager: plugin((phase) =>
					phase === 'pre_tool_use'
						? [
								action === 'error'
									? { action, message: 'The host refused.' }
									: { action, input: { score: 'Invalid host rewrite' } },
							]
						: [],
				),
			})
			const candidate = response()
			const prepared = await f.executor.prepareBatchForReview(candidate)
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
			expect(batch.results[0]).toMatchObject({ isError: true })
			expect(batch.results[0]).not.toHaveProperty('skipped')
			expect(batch.results[0]).not.toHaveProperty('inputFailure')
			expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty(
				'skipped',
			)
		},
	)

	it('a review denial outranks an already prepared skip without reporting it as skipped', async () => {
		const f = fixture({ pluginManager: skipPlugin() })
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(
			candidate,
			new Map([['output_call', 'The operator refused.']]),
			undefined,
			prepared,
		)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('skipped')
		expect(batch.results[0]).not.toHaveProperty('inputFailure')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty('skipped')
	})

	it('does not turn a provider argument failure into a hook skip', async () => {
		const f = fixture({ pluginManager: skipPlugin() })
		const candidate = response('{"score":"wrong"}')
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ isError: true, inputFailure: 'schema_validation' })
		expect(batch.results[0]).not.toHaveProperty('skipped')
	})

	it('cancellation before executing a prepared skip remains cancellation', async () => {
		const controller = new AbortController()
		const f = fixture({ pluginManager: skipPlugin(), abortSignal: controller.signal })
		const candidate = response()
		const prepared = await f.executor.prepareBatchForReview(candidate)
		controller.abort()
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ isError: true })
		expect(batch.results[0]).not.toHaveProperty('skipped')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty('skipped')
	})

	it('does not infer a skip from post-hook output text or raw provider metadata', async () => {
		const skippedText = skippedToolResultText('structured_output', 'Untrusted replacement text.')
		const f = fixture({
			pluginManager: plugin((phase) =>
				phase === 'post_tool_use' ? [{ action: 'replace', output: skippedText }] : [],
			),
		})
		const candidate = response('{"score":2,"skipped":true}', 'structured_output', {
			skipped: true,
		} as ToolCall['metadata'])
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ output: skippedText, isError: false })
		expect(batch.results[0]).not.toHaveProperty('skipped')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty('skipped')
		expect(f.executePrepared).toHaveBeenCalledOnce()
	})

	it('does not forward a raw tool result marker into trusted completion metadata', async () => {
		const tool = defineTool({
			name: 'raw_marker',
			description: 'Returns an extra untrusted property.',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'Actually executed.', skipped: true }),
		})
		const f = fixture({}, [tool])
		const candidate = response('{}', 'raw_marker')
		const prepared = await f.executor.prepareBatchForReview(candidate)
		const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
		expect(batch.results[0]).toMatchObject({ output: 'Actually executed.', isError: false })
		expect(batch.results[0]).not.toHaveProperty('skipped')
		expect(f.events.find((event) => event.type === 'tool_completed')).not.toHaveProperty('skipped')
	})

	it.each([false, true])(
		'marks a nested skip without marking its executed parent (legacy registry: %s)',
		async (legacyRegistry) => {
			const parent = defineTool({
				name: 'parent',
				description: 'Dispatches a child call.',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async (_input, context) => {
					if (!context.dispatchTool) throw new Error('No nested dispatcher.')
					return context.dispatchTool('structured_output', { score: 2 })
				},
			})
			const f = fixture(
				{ pluginManager: skipPlugin() },
				[createStructuredOutputTool(schema), parent],
				legacyRegistry,
			)
			const candidate = response('{}', 'parent')
			const prepared = await f.executor.prepareBatchForReview(candidate)
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)
			const completions = f.events.filter((event) => event.type === 'tool_completed')
			expect(completions).toHaveLength(2)
			expect(completions[0]).toMatchObject({
				toolName: 'structured_output',
				isError: false,
				skipped: true,
				via: { tool: 'parent', toolUseId: 'output_call' },
			})
			expect(completions[1]).toMatchObject({ toolName: 'parent', isError: false })
			expect(completions[1]).not.toHaveProperty('skipped')
			expect(batch.results[0]).not.toHaveProperty('skipped')
		},
	)
})

describe('durable skipped completion recovery', () => {
	it.each([true, undefined])(
		'retains the recorded %s marker without inferring it from text',
		async (skipped) => {
			const session = await sessionWithCheckpoint()
			const appended = await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: 'output_call',
				toolName: 'structured_output',
				result: skippedToolResultText('structured_output', 'Recorded receipt.'),
				isError: false,
				...(skipped ? { skipped } : {}),
			})
			const serialized = JSON.stringify(appended.record)
			expect(JSON.stringify(SessionRecordSchema.parse(appended.record))).toBe(serialized)
			const recorded = (
				await readToolExecutions(session.log, session.turnId, ['output_call'])
			).records.get('output_call')
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
			const f = fixture({ pluginManager: skipPlugin() })
			const batch = await f.executor.executeBatch(response(), undefined, recovered)
			for (const item of [
				appended.record,
				recorded,
				recovered.get('output_call'),
				batch.results[0],
			]) {
				if (skipped) expect(item).toHaveProperty('skipped', true)
				else expect(item).not.toHaveProperty('skipped')
				expect(item).not.toHaveProperty('inputFailure')
			}
			expect(batch.results[0]).toMatchObject({ isError: false })
			expect(f.execute).not.toHaveBeenCalled()
			expect(f.executePrepared).not.toHaveBeenCalled()
			expect(f.events).toHaveLength(0)
		},
	)

	it('an interrupted start cannot claim a skipped completion', async () => {
		const session = await sessionWithCheckpoint()
		await session.log.append(session.lease, {
			type: 'tool_executing',
			turnId: session.turnId,
			toolUseId: 'output_call',
			toolName: 'structured_output',
			input: { score: 2 },
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
		expect(recovered.get('output_call')).toMatchObject({ isError: true })
		expect(recovered.get('output_call')?.result).toContain('outcome is unknown')
		expect(recovered.get('output_call')).not.toHaveProperty('skipped')
	})

	it('rejects malformed and contradictory markers in both record validation and completion collection', async () => {
		const session = await sessionWithCheckpoint()
		const record = (
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: 'output_call',
				toolName: 'structured_output',
				result: 'Recorded receipt.',
				isError: false,
			})
		).record
		for (const invalid of [
			...['skip', null, false, 1, {}].map((skipped) => ({ ...record, skipped })),
			{ ...record, skipped: true, isError: true },
			{ ...record, skipped: true, inputFailure: 'schema_validation' },
			{ ...record, skipped: true, isError: true, inputFailure: 'schema_validation' },
		]) {
			expect(SessionRecordSchema.safeParse(invalid).success).toBe(false)
			const collector = new ToolExecutionCollector(session.turnId, ['output_call'])
			expect(() => collector.accept(invalid as unknown as SessionRecord)).toThrow(/classification/)
		}
	})
})
