import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const gate: AuthorizationGateConfig = {
	enabled: true,
	rules: [
		{
			type: 'custom_pattern',
			pattern: 'git push',
			target: 'args',
			decision: 'deny',
		},
		{ type: 'allow_by_name', toolNames: ['shell'] },
	],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

function params(
	provider: MockLLMProvider,
	tools: ToolRegistryContract,
	runStore: InMemoryRunStore,
) {
	return {
		provider,
		tools,
		runStore,
		agentId: 'prepared-authorization-agent',
		agentName: 'Prepared Authorization Agent',
		messages: [{ role: 'user' as const, content: 'run it' }],
		workingDirectory: process.cwd(),
		runConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 4,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		authorizationGate: gate,
	}
}

function provider() {
	return new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ id: 'call_1', name: 'shell', args: { command: 'status' } }],
			},
			{ text: 'done' },
		],
	})
}

describe('prepared tool authorization', () => {
	it('refuses duplicate call ids before hooks, review or execution', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'recorded' }))
		const review = vi.fn(async () => ({ action: 'approve_tools' as const }))
		const pluginManager = {
			executeHooks: vi.fn(async () => [{ action: 'continue' as const }]),
		} as unknown as PluginLifecycleManager
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'record',
				description: 'duplicate id fixture',
				inputSchema: z.object({ value: z.string() }),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute,
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'call_same', name: 'record', args: { value: 'first' } },
						{ id: 'call_same', name: 'record', args: { value: 'second' } },
					],
				},
			],
		})
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...params(provider, tools, new InMemoryRunStore()),
				authorizationGate: { ...gate, rules: [], denyDangerousPatterns: false },
				pluginManager,
				resumeHandler: review,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('failed')
		expect(execute).not.toHaveBeenCalled()
		expect(pluginManager.executeHooks).not.toHaveBeenCalledWith(
			'pre_tool_use',
			expect.anything(),
			expect.anything(),
		)
		expect(review).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'run_failed',
				error: expect.stringMatching(/duplicate tool call id "call_same"/i),
			}),
		)
	})

	it('authorizes the schema-transformed value the tool would actually execute', async () => {
		const executions: string[] = []
		const events: RunEvent[] = []
		const runStore = new InMemoryRunStore()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'schema-transforming shell fixture',
				inputSchema: z
					.object({ command: z.string() })
					.transform(() => ({ command: 'git push origin main' })),
				modelInputSchema: {
					type: 'object',
					properties: { command: { type: 'string' } },
					required: ['command'],
				},
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async ({ command }) => {
					executions.push(command)
					return { success: true, output: 'ran' }
				},
			}),
		)

		await drainQuery(params(provider(), tools, runStore), (event) => {
			events.push(event)
		})

		expect(executions).toEqual([])
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_executing',
				toolName: 'shell',
				input: { command: 'git push origin main' },
			}),
		)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolName: 'shell',
				isError: true,
				result: expect.stringMatching(/authorization gate/i),
			}),
		)
		expect(await runStore.readAuditEvents()).toContainEqual(
			expect.objectContaining({
				what: { action: 'tool_call', tool: 'shell' },
				outcome: 'refused',
				reason: expect.stringMatching(/git push/i),
			}),
		)
	})

	it('runs pre-tool rewrites before authorization', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'ran' }))
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'hook-transforming shell fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute,
			}),
		)
		const pluginManager = {
			executeHooks: vi.fn(async (event: string) =>
				event === 'pre_tool_use'
					? [{ action: 'modify', input: { command: 'git push origin main' } }]
					: [],
			),
		} as unknown as PluginLifecycleManager

		await drainQuery({
			...params(provider(), tools, new InMemoryRunStore()),
			pluginManager,
		})

		expect(execute).not.toHaveBeenCalled()
		expect(pluginManager.executeHooks).toHaveBeenCalledWith(
			'pre_tool_use',
			expect.objectContaining({ toolInput: { command: 'status' } }),
			expect.any(Function),
		)
	})

	it('reuses one prepared value across an opted-in retry', async () => {
		let parses = 0
		const executions: string[] = []
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'stateful transform fixture',
				inputSchema: z.object({ command: z.string() }).transform(({ command }) => ({
					command: `${command}-${++parses}`,
				})),
				modelInputSchema: {
					type: 'object',
					properties: { command: { type: 'string' } },
					required: ['command'],
				},
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				maxRetries: 1,
				execute: async ({ command }) => {
					executions.push(command)
					return executions.length === 1
						? { success: false, output: '', error: 'again', retryable: true }
						: { success: true, output: 'done' }
				},
			}),
		)
		const allow: AuthorizationGateConfig = {
			...gate,
			rules: [{ type: 'allow_by_name', toolNames: ['shell'] }],
		}

		await drainQuery({
			...params(provider(), tools, new InMemoryRunStore()),
			authorizationGate: allow,
			toolRetryBackoff: { initialDelayMs: 0, maxDelayMs: 0 },
		})

		expect(parses).toBe(1)
		expect(executions).toEqual(['status-1', 'status-1'])
	})

	it('shows a human reviewer the exact schema-transformed input', async () => {
		const execute = vi.fn(async () => ({ success: true, output: 'ran' }))
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'review projection fixture',
				inputSchema: z
					.object({ command: z.string() })
					.transform(({ command }) => ({ command: `normalized:${command}` })),
				modelInputSchema: {
					type: 'object',
					properties: { command: { type: 'string' } },
					required: ['command'],
				},
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute,
			}),
		)
		let request: HITLDecisionRequest | undefined
		const reviewGate: AuthorizationGateConfig = {
			...gate,
			rules: [],
			denyDangerousPatterns: false,
		}

		await drainQuery({
			...params(provider(), tools, new InMemoryRunStore()),
			authorizationGate: reviewGate,
			resumeHandler: async (pending) => {
				request = pending
				return { action: 'reject_tools', feedback: 'inspection complete' }
			},
		})

		expect(request).toEqual(
			expect.objectContaining({
				type: 'tool_review',
				toolCalls: [expect.objectContaining({ input: { command: 'normalized:status' } })],
			}),
		)
		expect(execute).not.toHaveBeenCalled()
	})

	it('fails closed when a custom registry cannot bind review to execution', async () => {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'legacy registry fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => ({ success: true, output: 'ran' }),
			}),
		)
		const legacyExecute = vi.spyOn(tools, 'execute')
		const legacy = new Proxy(tools, {
			get(target, property) {
				if (property === 'prepareExecution' || property === 'executePrepared') return undefined
				const value = Reflect.get(target, property, target)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}) as unknown as ToolRegistryContract
		const events: RunEvent[] = []
		const allow: AuthorizationGateConfig = {
			...gate,
			rules: [{ type: 'allow_by_name', toolNames: ['shell'] }],
		}

		await drainQuery(
			{
				...params(provider(), legacy, new InMemoryRunStore()),
				authorizationGate: allow,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(legacyExecute).not.toHaveBeenCalled()
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolName: 'shell',
				isError: true,
				result: expect.stringMatching(/cannot bind authorization/i),
			}),
		)
	})

	it('does not let an in-place pre-tool hook mutate the retained executable value', async () => {
		const executions: string[] = []
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'shell',
				description: 'detached review fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async ({ command }) => {
					executions.push(command)
					return { success: true, output: 'ran' }
				},
			}),
		)
		let hookInputWasFrozen = false
		const pluginManager = {
			executeHooks: vi.fn(async (_event: string, context: { toolInput: unknown }) => {
				hookInputWasFrozen = Object.isFrozen(context.toolInput)
				try {
					;(context.toolInput as { command: string }).command = 'git push origin main'
				} catch {
					// A frozen review projection is expected to reject this assignment.
				}
				return [{ action: 'continue' }]
			}),
		} as unknown as PluginLifecycleManager
		const allow: AuthorizationGateConfig = {
			...gate,
			rules: [{ type: 'allow_by_name', toolNames: ['shell'] }],
		}

		await drainQuery({
			...params(provider(), tools, new InMemoryRunStore()),
			authorizationGate: allow,
			pluginManager,
		})

		expect(hookInputWasFrozen).toBe(true)
		expect(executions).toEqual(['status'])
	})
})
