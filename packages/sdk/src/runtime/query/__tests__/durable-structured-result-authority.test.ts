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
import { recoverCompletedCalls } from '../resume-pending.js'
import { ToolExecutionCollector, readToolExecutions } from '../tool-executions.js'
import { sessionWithCheckpoint } from './support/session.js'

const schema = z.object({ score: z.number() })
const makeLogger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(
	name = 'structured_output',
	argumentsText = '{"score":2}',
	metadata?: ToolCall['metadata'],
): ChatCompletionResponse {
	return {
		id: 'durable-output-response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'output_call',
					type: 'function',
					function: { name, arguments: argumentsText },
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
	owner: ToolDefinition = createStructuredOutputTool(schema),
	registered: readonly ToolDefinition[] = [owner],
	extra: Partial<ToolExecutorConfig> = {},
) {
	const turnId = generateTurnId()
	const tools = new ToolManager({ toolsets: [testToolset(...registered)], messages: () => [] })
	const execute = vi.spyOn(tools, 'execute')
	const executePrepared = vi.spyOn(tools, 'executePrepared')
	const events: SessionEventDraft[] = []
	const executor = new ToolExecutor(
		{
			tools,
			durableStructuredOutputTool: owner,
			turnId,
			sessionId: generateSessionId(),
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			toolResultGuardrails: [],
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
		makeLogger(),
	)
	return { executor, tools, execute, executePrepared, events }
}

function plugin(hook: (phase: string) => readonly PluginHookResult[]): PluginLifecycleManager {
	return {
		executeHooks: vi.fn(async (phase: string) => hook(phase)),
	} as unknown as PluginLifecycleManager
}

function expectNoMarker(
	f: ReturnType<typeof fixture>,
	batch: Awaited<ReturnType<ToolExecutor['executeBatch']>>,
) {
	for (const result of batch.results) expect(result).not.toHaveProperty('structuredResultJson')
	for (const event of f.events) expect(event).not.toHaveProperty('structuredResultJson')
	for (const message of batch.messages) expect(message).not.toHaveProperty('structuredResultJson')
}

describe('authority to retain a durable structured result', () => {
	it.each([false, true])(
		'retains only an executed owner receipt (explicit batch preparation: %s)',
		async (prepare) => {
			const owner = createStructuredOutputTool(schema)
			const f = fixture(owner)
			const candidate = response()
			const prepared = prepare ? await f.executor.prepareBatchForReview(candidate) : undefined
			const batch = await f.executor.executeBatch(candidate, undefined, undefined, prepared)

			expect(f.tools.get('structured_output')).toBe(owner)
			expect(f.executePrepared).toHaveBeenCalledOnce()
			expect(batch.results[0]).toMatchObject({
				isError: false,
				structuredResultJson: '{"score":2}',
			})
			expect(f.events.find((event) => event.type === 'tool_completed')).toMatchObject({
				structuredResultJson: '{"score":2}',
			})
			expect(f.events.find((event) => event.type === 'tool_executing')).not.toHaveProperty(
				'structuredResultJson',
			)
			expect(batch.messages[0]).not.toHaveProperty('structuredResultJson')
		},
	)

	it('retains the screened and post-hook selection rather than raw arguments or ToolResult.data', async () => {
		const screen = vi.fn(() => ({ action: 'rewrite' as const, output: '{"score":7}' }))
		const f = fixture(undefined, undefined, {
			toolResultGuardrails: [screen],
			pluginManager: plugin((phase) =>
				phase === 'post_tool_use' ? [{ action: 'replace', output: '{"score":9}' }] : [],
			),
		})
		const batch = await f.executor.executeBatch(response())

		expect(screen).toHaveBeenCalledOnce()
		expect(batch.results[0]).toMatchObject({
			output: '{"score":9}',
			structuredResultJson: '{"score":9}',
			isError: false,
		})
		expect(f.events.find((event) => event.type === 'tool_completed')).toMatchObject({
			structuredResultJson: '{"score":9}',
		})
	})

	it('keeps the selected JSON before a bounded display preview truncates it', async () => {
		const owner = createStructuredOutputTool(z.object({ text: z.string() }))
		const selected = JSON.stringify({ text: 'a'.repeat(500) })
		const f = fixture(owner, [owner], { maxToolOutputChars: 80 })
		const batch = await f.executor.executeBatch(response('structured_output', selected))

		expect(batch.results[0]?.output.length).toBeLessThanOrEqual(80)
		expect(batch.results[0]?.output).not.toBe(selected)
		expect(batch.results[0]?.structuredResultJson).toBe(selected)
		expect(f.events.find((event) => event.type === 'tool_completed')).toMatchObject({
			outputTruncated: true,
			structuredResultJson: selected,
		})
	})

	it('does not transfer the owner authority to an alternate definition with the same name', async () => {
		const owner = createStructuredOutputTool(schema)
		const replacement = createStructuredOutputTool(schema)
		const f = fixture(owner, [replacement])
		const batch = await f.executor.executeBatch(response())

		expect(f.executePrepared).toHaveBeenCalledOnce()
		expect(batch.results[0]).toMatchObject({ isError: false, output: '{"score":2}' })
		expectNoMarker(f, batch)
	})

	it('does not infer an owner binding from a successful structured_output name', async () => {
		const f = fixture(undefined, undefined, { durableStructuredOutputTool: undefined })
		const batch = await f.executor.executeBatch(response())
		expect(batch.results[0]?.isError).toBe(false)
		expectNoMarker(f, batch)
	})

	it('requires a ready preparation rather than trusting a legacy raw execute result', async () => {
		const owner = createStructuredOutputTool(schema)
		const tools = new ToolManager({ toolsets: [testToolset(owner)], messages: () => [] })
		const execute = vi.spyOn(tools, 'execute')
		const legacy = {
			get: tools.get.bind(tools),
			has: tools.has.bind(tools),
			listNames: tools.listNames.bind(tools),
			availability: tools.availability.bind(tools),
			execute: tools.execute.bind(tools),
		} as unknown as ToolManager
		const f = fixture(owner, [owner], { tools: legacy })
		const batch = await f.executor.executeBatch(response())

		expect(execute).toHaveBeenCalledOnce()
		expect(batch.results[0]).toMatchObject({ isError: false, output: '{"score":2}' })
		expectNoMarker(f, batch)
	})

	it('does not promote raw tool-result properties, data, provider metadata or argument fields', async () => {
		const forged = '{"score":999}'
		const other = defineTool({
			name: 'other',
			description: 'Untrusted marker fixture',
			inputSchema: z.object({ structuredResultJson: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({
				success: true,
				output: '{"score":2}',
				data: { structuredResultJson: forged, score: 999 },
				structuredResultJson: forged,
			}),
		})
		const f = fixture(undefined, [other])
		const candidate = response('other', JSON.stringify({ structuredResultJson: forged }), {
			structuredResultJson: forged,
		} as ToolCall['metadata'])
		const batch = await f.executor.executeBatch(candidate)

		expect(batch.results[0]).toMatchObject({ isError: false, output: '{"score":2}' })
		expectNoMarker(f, batch)
	})

	it.each(['unknown', 'other'])(
		'does not mint evidence when an original %s call is repaired into the bound output tool',
		async (originalName) => {
			const owner = createStructuredOutputTool(schema)
			const executeOther = vi.fn(async () => ({ success: true, output: 'unreachable' }))
			const other = defineTool({
				name: 'other',
				description: 'Repair source fixture',
				inputSchema: z.object({ required: z.boolean() }),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: executeOther,
			})
			const repair = vi.fn(() => ({ toolName: 'structured_output', arguments: '{"score":2}' }))
			const f = fixture(owner, [owner, other], { repairToolCall: repair })
			const batch = await f.executor.executeBatch(response(originalName))

			expect(repair).toHaveBeenCalledOnce()
			expect(f.executePrepared).toHaveBeenCalledOnce()
			expect(executeOther).not.toHaveBeenCalled()
			expect(batch.results[0]).toMatchObject({
				toolName: 'structured_output',
				output: '{"score":2}',
				isError: false,
			})
			expectNoMarker(f, batch)
		},
	)

	it('does not grant nested owner calls or their successful parent a final-output artifact', async () => {
		const owner = createStructuredOutputTool(schema)
		const parent = defineTool({
			name: 'parent',
			description: 'Nested output fixture',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (_input, context) => {
				if (!context.dispatchTool) throw new Error('Missing nested dispatch')
				return context.dispatchTool('structured_output', { score: 2 })
			},
		})
		const f = fixture(owner, [owner, parent])
		const batch = await f.executor.executeBatch(response('parent', '{}'))

		expect(f.events.filter((event) => event.type === 'tool_completed')).toHaveLength(2)
		expect(batch.results[0]).toMatchObject({ output: '{"score":2}', isError: false })
		expectNoMarker(f, batch)
	})

	it.each(['screen', 'post-hook'] as const)(
		'does not keep evidence from a successful tool when the %s selects invalid JSON',
		async (selection) => {
			const f = fixture(undefined, undefined, {
				...(selection === 'screen'
					? { toolResultGuardrails: [() => ({ action: 'rewrite' as const, output: 'withheld' })] }
					: {
							pluginManager: plugin((phase) =>
								phase === 'post_tool_use' ? [{ action: 'replace', output: 'withheld' }] : [],
							),
						}),
			})
			const batch = await f.executor.executeBatch(response())
			expect(batch.results[0]).toMatchObject({ isError: false, output: 'withheld' })
			expectNoMarker(f, batch)
		},
	)

	it('cannot retain a failed tool receipt even when its output and data contain valid JSON', async () => {
		const owner = {
			...createStructuredOutputTool(schema),
			execute: vi.fn(async () => ({ success: false, output: '{"score":2}', data: { score: 2 } })),
		}
		const f = fixture(owner)
		const batch = await f.executor.executeBatch(response())
		expect(owner.execute).toHaveBeenCalledOnce()
		expect(batch.results[0]?.isError).toBe(true)
		expectNoMarker(f, batch)
	})

	it.each(['skip', 'denied', 'invalid-input'] as const)(
		'does not retain evidence for a %s call that never executed',
		async (admission) => {
			const f = fixture(undefined, undefined, {
				...(admission === 'skip'
					? {
							pluginManager: plugin((phase) =>
								phase === 'pre_tool_use' ? [{ action: 'skip', reason: 'not executed' }] : [],
							),
						}
					: {}),
			})
			const candidate = response(
				'structured_output',
				admission === 'invalid-input' ? '{"score":"invalid"}' : '{"score":2}',
			)
			const prepared = await f.executor.prepareBatchForReview(candidate)
			const batch = await f.executor.executeBatch(
				candidate,
				admission === 'denied' ? new Map([['output_call', 'denied']]) : undefined,
				undefined,
				prepared,
			)
			expect(f.executePrepared).not.toHaveBeenCalled()
			expectNoMarker(f, batch)
		},
	)

	it('withholds evidence if cancellation arrives after execution but before the selected receipt', async () => {
		const controller = new AbortController()
		const f = fixture(undefined, undefined, {
			abortSignal: controller.signal,
			pluginManager: plugin((phase) => {
				if (phase !== 'post_tool_use') return []
				controller.abort(new Error('cancel before durable publication'))
				return [{ action: 'replace', output: '{"score":9}' }]
			}),
		})
		const batch = await f.executor.executeBatch(response())
		expect(f.executePrepared).toHaveBeenCalledOnce()
		expect(controller.signal.aborted).toBe(true)
		expectNoMarker(f, batch)
	})
})

describe('trusted durable structured-result recovery', () => {
	it('recovers retained JSON through the collector without rerunning schema, tool or hooks', async () => {
		const session = await sessionWithCheckpoint()
		const appended = await session.log.append(session.lease, {
			type: 'tool_completed',
			turnId: session.turnId,
			toolUseId: 'output_call',
			toolName: 'structured_output',
			result: '[bounded receipt]',
			isError: false,
			structuredResultJson: '{"score":2}',
		})
		expect(SessionRecordSchema.parse(appended.record)).toHaveProperty(
			'structuredResultJson',
			'{"score":2}',
		)
		const snapshot = await readToolExecutions(session.log, session.turnId, ['output_call'])
		expect(snapshot.records.get('output_call')).toHaveProperty(
			'structuredResultJson',
			'{"score":2}',
		)
		const recovered = await recoverCompletedCalls(
			{
				flush: async () => {},
				log: session.log,
				turnId: session.turnId,
			} as unknown as TurnRecorder,
			response().message.toolCalls ?? [],
			makeLogger(),
		)
		const refine = vi.fn(() => {})
		const owner = createStructuredOutputTool(schema.superRefine(refine))
		const hooks = plugin(() => [{ action: 'error', message: 'must not run' }])
		const f = fixture(owner, [owner], { pluginManager: hooks })
		const batch = await f.executor.executeBatch(response(), undefined, recovered)

		expect(batch.results[0]).toMatchObject({
			output: '[bounded receipt]',
			isError: false,
			structuredResultJson: '{"score":2}',
		})
		expect(refine).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.executePrepared).not.toHaveBeenCalled()
		expect(hooks.executeHooks).not.toHaveBeenCalled()
		expect(f.events).toHaveLength(0)
	})

	it('rejects malformed or contradictory retained evidence rather than falling back to valid preview text', async () => {
		const session = await sessionWithCheckpoint()
		const record = (
			await session.log.append(session.lease, {
				type: 'tool_completed',
				turnId: session.turnId,
				toolUseId: 'output_call',
				toolName: 'structured_output',
				result: '{"score":2}',
				isError: false,
			})
		).record
		for (const invalid of [
			...[null, false, 2, {}, 'not JSON', '1e400', '-0'].map((structuredResultJson) => ({
				...record,
				structuredResultJson,
			})),
			{ ...record, structuredResultJson: '{"score":2}', toolName: 'other' },
			{ ...record, structuredResultJson: '{"score":2}', isError: true },
			{ ...record, structuredResultJson: '{"score":2}', skipped: true },
			{
				...record,
				structuredResultJson: '{"score":2}',
				via: { tool: 'parent', toolUseId: 'parent_call' },
			},
		]) {
			expect(SessionRecordSchema.safeParse(invalid).success).toBe(false)
			const collector = new ToolExecutionCollector(session.turnId, ['output_call'])
			expect(() => collector.accept(invalid as unknown as SessionRecord)).toThrow()
			expect(collector.finish().records.size).toBe(0)
		}
	})
})
