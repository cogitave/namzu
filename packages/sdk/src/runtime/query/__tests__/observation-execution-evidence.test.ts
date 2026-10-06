import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { liveToolset } from '../../../toolsets/__fixtures__/toolsets.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { Message, ToolCall, ToolMessage } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'
import { projectObservationContext } from '../observation-context.js'

const body = 'A long, exact observation with evidence.\n'.repeat(100)

function response(id: string, args = '{"path":" a "}'): ChatCompletionResponse {
	return {
		id: `response-${id}`,
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id, type: 'function', function: { name: 'observe', arguments: args } }],
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

function logger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function fixture(
	definition: ToolDefinition,
	overrides: Partial<ToolExecutorConfig> = {},
	set?: Toolset,
) {
	const tools = new ToolManager({ toolsets: [set ?? testToolset(definition)], messages: () => [] })
	const turnId = generateTurnId()
	const executor = new ToolExecutor(
		{
			sessionId: generateSessionId(),
			turnId,
			tools,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...overrides,
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		logger(),
	)
	return { executor, tools }
}

function observeTool(
	schema: z.ZodType = z.object({ path: z.string() }),
	readOnly: (input: unknown) => boolean = () => true,
	destructive: (input: unknown) => boolean = () => false,
): ToolDefinition {
	return defineTool({
		name: 'observe',
		description: 'Observe a path',
		inputSchema: schema,
		category: 'custom',
		permissions: [],
		readOnly,
		destructive,
		concurrencySafe: true,
		execute: async () => ({ success: true, output: body }),
	})
}

async function execute(executor: ToolExecutor, candidate: ChatCompletionResponse) {
	const prepared = await executor.prepareBatchForReview(candidate)
	const batch = await executor.executeBatch(candidate, undefined, undefined, prepared)
	const call = candidate.message.toolCalls?.[0]
	const message = batch.messages[0]
	if (!call || !message || message.role !== 'tool') throw new Error('Expected one tool result')
	return { call, message }
}

function history(...pairs: readonly { call: ToolCall; message: ToolMessage }[]): Message[] {
	return pairs.flatMap(({ call, message }) => [
		{ role: 'assistant' as const, content: null, toolCalls: [call] },
		message,
	])
}

describe('executor-owned observation evidence', () => {
	it('binds a successful execution to its exact call and visible result without replaying async schema effects', async () => {
		const effects = { refinements: 0, transforms: 0 }
		const schema = z
			.object({ path: z.string() })
			.superRefine(async () => {
				effects.refinements++
			})
			.transform(async ({ path }) => {
				effects.transforms++
				return { path: path.trim() }
			})
		const readOnly = vi.fn((input: unknown) => (input as { path: string }).path === 'a')
		const destructive = vi.fn(() => false)
		const { executor, tools } = fixture(observeTool(schema, readOnly, destructive))
		const first = await execute(executor, response('first'))
		const second = await execute(executor, response('second'))
		expect(executor.recordedObservationKey(first.call, first.message)).toBeDefined()
		expect(executor.recordedObservationKey(second.call, second.message)).toBeDefined()
		expect(readOnly).toHaveBeenCalledTimes(2)
		expect(readOnly).toHaveBeenNthCalledWith(1, { path: 'a' })
		expect(destructive).toHaveBeenCalledTimes(2)
		const beforeProjection = { ...effects }
		const beforeReadOnly = readOnly.mock.calls.length
		const beforeDestructive = destructive.mock.calls.length
		const messages = history(first, second)
		for (let request = 0; request < 2; request++) {
			const projected = projectObservationContext(messages, tools, [], (call, message) =>
				executor.recordedObservationKey(call, message),
			)
			expect(projected[1]?.content).toBe(body)
			expect(projected[3]?.content).toContain('Duplicate observation')
		}
		expect(effects).toEqual(beforeProjection)
		expect(readOnly).toHaveBeenCalledTimes(beforeReadOnly)
		expect(destructive).toHaveBeenCalledTimes(beforeDestructive)

		expect(
			executor.recordedObservationKey(
				{ ...first.call, function: { ...first.call.function, arguments: '{"path":"b"}' } },
				first.message,
			),
		).toBeUndefined()
		expect(
			executor.recordedObservationKey(
				{ ...first.call, function: { ...first.call.function, name: 'another' } },
				first.message,
			),
		).toBeUndefined()
		expect(
			executor.recordedObservationKey(first.call, { ...first.message, content: `${body}changed` }),
		).toBeUndefined()
		expect(
			executor.recordedObservationKey(first.call, { ...first.message, toolCallId: 'wrong' }),
		).toBeUndefined()
		expect(
			executor.recordedObservationKey(first.call, { ...first.message, isError: true }),
		).toBeUndefined()
	})

	it('revokes evidence when the admitted tool definition is replaced', async () => {
		const original = observeTool()
		const live = liveToolset('live-observation', [original])
		const { executor, tools } = fixture(original, {}, live.toolset)
		const pair = await execute(executor, response('first'))
		expect(executor.recordedObservationKey(pair.call, pair.message)).toBeDefined()
		live.setTools([])
		tools.refresh()
		const replacement = observeTool()
		live.setTools([replacement])
		tools.refresh()
		expect(tools.get('observe')).toBe(replacement)
		expect(executor.recordedObservationKey(pair.call, pair.message)).toBeUndefined()
	})

	it('does not merge equal raw calls and output when async preparation produced different inputs', async () => {
		let preparations = 0
		const actualPaths: string[] = []
		const schema = z.object({ path: z.string() }).transform(async () => ({
			path: `${++preparations}.ts`,
		}))
		const definition = defineTool({
			name: 'observe',
			description: 'Observe the prepared path',
			inputSchema: schema,
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ path }) => {
				actualPaths.push(path)
				return { success: true, output: body }
			},
		})
		const { executor, tools } = fixture(definition)
		const first = await execute(executor, response('first'))
		const second = await execute(executor, response('second'))
		expect(actualPaths).toEqual(['1.ts', '2.ts'])
		expect(executor.recordedObservationKey(first.call, first.message)).not.toBe(
			executor.recordedObservationKey(second.call, second.message),
		)
		const messages = history(first, second)
		expect(
			projectObservationContext(messages, tools, [], (call, message) =>
				executor.recordedObservationKey(call, message),
			),
		).toBe(messages)
		expect(preparations).toBe(2)
	})

	it.each(['readOnly', 'destructive'] as const)(
		'keeps successful output intact when advisory %s throws',
		async (predicate) => {
			const throws = () => {
				throw new Error('advisory classification failed')
			}
			const definition = observeTool(
				undefined,
				predicate === 'readOnly' ? throws : () => true,
				predicate === 'destructive' ? throws : () => false,
			)
			const { executor, tools } = fixture(definition)
			const first = await execute(executor, response('first'))
			const second = await execute(executor, response('second'))
			expect(first.message.content).toBe(body)
			expect(first.message.isError).toBeFalsy()
			expect(executor.recordedObservationKey(first.call, first.message)).toBeUndefined()
			const messages = history(first, second)
			expect(
				projectObservationContext(messages, tools, [], (call, message) =>
					executor.recordedObservationKey(call, message),
				),
			).toBe(messages)
		},
	)

	it('does not promote a recovered result or a denied call to an executed observation', async () => {
		const { executor } = fixture(observeTool())
		const candidate = response('reused')
		const first = await execute(executor, candidate)
		expect(executor.recordedObservationKey(first.call, first.message)).toBeDefined()
		const recovered = await executor.executeBatch(
			candidate,
			undefined,
			new Map([['reused', { result: body, isError: false }]]),
		)
		const recoveredMessage = recovered.messages[0]
		if (!recoveredMessage || recoveredMessage.role !== 'tool') throw new Error('Expected recovery')
		expect(executor.recordedObservationKey(first.call, recoveredMessage)).toBeUndefined()

		const deniedCandidate = response('denied')
		const prepared = await executor.prepareBatchForReview(deniedCandidate)
		const denied = await executor.executeBatch(
			deniedCandidate,
			new Map([['denied', 'Operator rejected this call']]),
			undefined,
			prepared,
		)
		const deniedCall = deniedCandidate.message.toolCalls?.[0]
		const deniedMessage = denied.messages[0]
		if (!deniedCall || !deniedMessage || deniedMessage.role !== 'tool')
			throw new Error('Expected denial')
		expect(executor.recordedObservationKey(deniedCall, deniedMessage)).toBeUndefined()
	})

	it('does not promote a successful synthetic skip to an executed observation', async () => {
		const pluginManager = {
			executeHooks: vi.fn(
				async (phase: string): Promise<PluginHookResult[]> =>
					phase === 'pre_tool_use' ? [{ action: 'skip', reason: 'Deferred by the host' }] : [],
			),
		} as unknown as ToolExecutorConfig['pluginManager']
		const { executor } = fixture(observeTool(), { pluginManager })
		const candidate = response('skipped')
		const prepared = await executor.prepareBatchForReview(candidate)
		const batch = await executor.executeBatch(candidate, undefined, undefined, prepared)
		const call = candidate.message.toolCalls?.[0]
		const message = batch.messages[0]
		if (!call || !message || message.role !== 'tool') throw new Error('Expected skip')
		expect(batch.results[0]).toMatchObject({ skipped: true, isError: false })
		expect(executor.recordedObservationKey(call, message)).toBeUndefined()
	})
})
