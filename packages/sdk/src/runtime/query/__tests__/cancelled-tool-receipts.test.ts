import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { PluginRegistry } from '../../../registry/plugin/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { PluginId } from '../../../types/ids/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateTurnId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type LogContext, type Logger, resolveLogger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'
import { drainQuery } from '../index.js'
import { readToolExecutions } from '../tool-executions.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'

describe('cancellation after a tool returned its receipt', () => {
	it('persists the completed call in a cancelled real query without leaking its unreviewed output', async () => {
		const caller = new AbortController()
		const turnId = generateTurnId()
		const tools = new ToolRegistry()
		let executions = 0
		tools.register({
			name: 'commit',
			description: 'Commit a transaction.',
			inputSchema: z.object({}),
			execute: async () => {
				executions++
				return { success: true, output: 'private receipt: payment-123' }
			},
		})
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			toolRegistry: tools,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: resolveLogger(undefined),
		})
		manager.registerHook('receipt_redactor' as PluginId, {
			event: 'post_tool_use',
			handler: async () => {
				caller.abort(new Error('operator stopped during review'))
				return { action: 'continue' }
			},
		})
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'committed', name: 'commit', args: {} }] }],
		})
		const sessionId = generateSessionId()
		const sessionLog = new InMemorySessionLog({ sessionId })
		const run = await drainQuery({
			turnId,
			provider,
			tools,
			pluginManager: manager,
			budget: SessionTokenBudget.create(100_000, { rootSessionId: sessionId, rootTurnId: turnId }),
			sessionLog,
			projectId: generateProjectId(),
			sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			workingDirectory: process.cwd(),
			agentId: 'receipt-observer',
			agentName: 'Receipt observer',
			messages: [{ role: 'user', content: 'commit once' }],
			signal: caller.signal,
			turnConfig: {
				model: 'mock',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				permissionMode: 'auto',
			},
		})
		expect(run.status).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		expect(executions).toBe(1)
		const record = (await readToolExecutions(sessionLog, turnId, ['committed'])).records.get(
			'committed',
		)
		expect(record).toMatchObject({
			isError: false,
			result: expect.stringContaining('reported success'),
		})
		expect(record?.result).toContain('withheld')
		const history = (await readFoldedHistory(sessionLog)).map((entry) => entry.message)
		expect(history.filter((message) => message.role === 'tool')).toHaveLength(1)
		expect(JSON.stringify(history)).not.toContain('private receipt')
		expect(JSON.stringify(history)).toContain('reported success')
	})

	it.each([
		{ success: true, hook: 'post_tool_use' as const },
		{ success: false, hook: 'post_tool_use' as const },
		{ success: true, hook: 'pre_tool_use' as const },
	])(
		'retains an execution receipt when cancellation interrupts $hook (success=$success)',
		async ({ success, hook }) => {
			const caller = new AbortController()
			const turnId = generateTurnId()
			const tools = new ToolRegistry()
			let executions = 0
			const receipt = {
				success,
				output: 'private receipt: payment-123',
				...(!success ? { error: 'private cancelled-review diagnostic', retryable: true } : {}),
				content: [{ type: 'text' as const, text: 'private model receipt' }],
			}
			tools.register({
				name: 'commit',
				description: 'Commit a transaction.',
				inputSchema: z.object({}),
				maxRetries: 1,
				execute: async () => {
					executions++
					return receipt
				},
			})
			const manager = new PluginLifecycleManager({
				pluginRegistry: new PluginRegistry(),
				toolRegistry: tools,
				scopeRoots: { project: process.cwd(), user: process.cwd() },
				log: resolveLogger(undefined),
			})
			let enter!: () => void
			const entered = new Promise<void>((resolve) => {
				enter = resolve
			})
			let release!: (result: PluginHookResult) => void
			const held = new Promise<PluginHookResult>((resolve) => {
				release = resolve
			})
			let hookCalls = 0
			manager.registerHook('receipt_redactor' as PluginId, {
				event: hook,
				handler: async () => {
					hookCalls++
					if (hook === 'pre_tool_use' && hookCalls === 1) return { action: 'continue' }
					enter()
					return held
				},
			})
			const events: SessionEvent[] = []
			const logged: { message: string; data?: LogContext }[] = []
			const record = (message: string, data?: LogContext) => {
				logged.push({ message, data })
			}
			const log: Logger = {
				debug: record,
				info: record,
				warn: record,
				error: record,
				child: () => log,
			}
			const executor = new ToolExecutor(
				{
					tools,
					pluginManager: manager,
					sessionId: generateSessionId(),
					turnId,
					workingDirectory: process.cwd(),
					permissionMode: 'auto',
					env: {},
					abortSignal: caller.signal,
				},
				new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
				async (event) => {
					events.push(event)
				},
				log,
			)
			const response = {
				message: {
					role: 'assistant',
					content: null,
					toolCalls: ['committed', 'queued'].map((id) => ({
						id,
						type: 'function',
						function: { name: 'commit', arguments: '{}' },
					})),
				},
				finishReason: 'tool_calls',
				usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			} as ChatCompletionResponse
			const pending = executor.executeBatch(response)
			await entered
			if (hook === 'pre_tool_use') {
				expect(events.filter((event) => event.type === 'tool_completed')).toHaveLength(1)
			}
			caller.abort(new Error('operator stopped during output review'))
			try {
				const batch = await pending
				expect(executions).toBe(1)
				expect(batch.observations).toHaveLength(1)
				expect(batch.observations[0]?.result).toEqual(receipt)
				expect(batch.results).toHaveLength(2)
				expect(batch.results[1]?.output).toContain('not started')
				expect(batch.messages).toHaveLength(2)
				const completed = events.filter((event) => event.type === 'tool_completed')
				expect(completed.map((event) => event.toolUseId)).toEqual(['committed', 'queued'])
				if (hook === 'post_tool_use') {
					expect(batch.results[0]?.output).toContain(
						success ? 'reported success' : 'reported failure',
					)
					expect(batch.results[0]?.output).toContain('withheld')
					expect(JSON.stringify(batch.messages)).not.toContain('private')
					expect(JSON.stringify(completed)).not.toContain('private')
					expect(JSON.stringify(logged)).not.toContain('private')
					expect(logged.some((entry) => entry.message === 'Retrying a failed tool call')).toBe(
						false,
					)
				} else {
					// The first call's review completed before the second pre-hook
					// began. Its actual output remains valid evidence.
					expect(batch.results[0]).toMatchObject({ output: receipt.output, isError: false })
					expect(JSON.stringify(batch.messages)).toContain('private model receipt')
				}
			} finally {
				release({ action: 'replace', output: 'approved late receipt' })
				await pending.catch(() => {})
			}
		},
	)
})
