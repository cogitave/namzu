import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { probe } from '../../../probe/registry.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { buildRunCodeTool } from '../../../tools/builtins/run-code.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A nested dispatch is model-reachable authority, not a convenience callback.
 *
 * The executor used to hand that callback to a tool for the lifetime of the
 * run. A plugin could retain it, let its visible call settle, and dispatch a
 * second tool after the call — or even after `run_completed`. The same nested
 * path also skipped the operator authorization gate entirely, so an allowed
 * `run_code` parent could invoke a child the operator explicitly denied.
 *
 * These are real-query observers. A helper-level test can prove a signal was
 * aborted while missing that the production closure still emits events and
 * reaches the registry after the model-visible call has ended.
 */

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	id,
	name,
	args,
})

function params(provider: MockLLMProvider, tools: ToolRegistry) {
	return {
		provider,
		tools,
		agentId: 'nested-authority-agent',
		agentName: 'Nested Authority Agent',
		messages: [{ role: 'user' as const, content: 'run the requested tool' }],
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
	}
}

function parentTool(
	name: string,
	execute: (context: ToolContext) => Promise<{ success: boolean; output: string }>,
	timeoutMs: number,
) {
	return defineTool({
		name,
		description: `${name} test parent`,
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: false,
		timeoutMs,
		execute: async (_input, context) => execute(context),
	})
}

function lateTool(onExecute: () => void) {
	return defineTool({
		name: 'late_effect',
		description: 'records a late effect',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: false,
		execute: async () => {
			onExecute()
			return { success: true, output: 'late effect ran' }
		},
	})
}

describe('nested dispatch authority', () => {
	it('cannot be retained and used after a successful parent call settles', async () => {
		let retained: ToolContext['dispatchTool']
		let effects = 0
		const events: RunEvent[] = []
		const tools = new ToolRegistry()
		tools.register(
			parentTool(
				'capture_dispatch',
				async (context) => {
					retained = context.dispatchTool
					return { success: true, output: 'captured' }
				},
				// A disabled deadline used to bypass creation of any invocation
				// controller, making this the sharpest form of the lifetime gap.
				0,
			),
		)
		tools.register(lateTool(() => effects++))
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [call('parent', 'capture_dispatch', {})] }, { text: 'done' }],
		})

		await drainQuery(params(provider, tools), (event) => {
			events.push(event)
		})
		const eventCount = events.length
		const dispatch = retained
		expect(dispatch).toBeDefined()

		await expect(dispatch?.('late_effect', {})).rejects.toThrow(/invocation.*settled/i)
		expect(effects).toBe(0)
		expect(events).toHaveLength(eventCount)
		expect(events.at(-1)?.type).toBe('run_completed')
	})

	it('cannot be retained and used after the parent is abandoned on timeout', async () => {
		let retained: ToolContext['dispatchTool']
		let effects = 0
		const events: RunEvent[] = []
		const tools = new ToolRegistry()
		tools.register(
			parentTool(
				'capture_then_hang',
				async (context) => {
					retained = context.dispatchTool
					await new Promise<void>(() => {})
					return { success: true, output: 'unreachable' }
				},
				20,
			),
		)
		tools.register(lateTool(() => effects++))
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [call('parent', 'capture_then_hang', {})] }, { text: 'recovered' }],
		})

		await drainQuery(params(provider, tools), (event) => {
			events.push(event)
		})
		const eventCount = events.length
		const dispatch = retained
		expect(dispatch).toBeDefined()

		await expect(dispatch?.('late_effect', {})).rejects.toThrow(/invocation.*settled/i)
		expect(effects).toBe(0)
		expect(events).toHaveLength(eventCount)
	})

	it('settles an already-started nested call before reporting its parent complete', async () => {
		let childSignal: AbortSignal | undefined
		let releaseChild: (() => void) | undefined
		let markChildStarted: (() => void) | undefined
		const childStarted = new Promise<void>((resolve) => {
			markChildStarted = resolve
		})
		const childRelease = new Promise<void>((resolve) => {
			releaseChild = resolve
		})
		const events: RunEvent[] = []
		const tools = new ToolRegistry()
		tools.register(
			parentTool(
				'fire_and_forget',
				async (context) => {
					const pending = context.dispatchTool?.('held_child', {})
					void pending?.catch(() => {})
					// Wait only for admission into the child tool, not for its result.
					// This pins the harder case: cleanup must own work which really
					// started, not merely reject a queued dispatch before the registry.
					await childStarted
					return { success: true, output: 'parent returned' }
				},
				0,
			),
		)
		tools.register(
			defineTool({
				name: 'held_child',
				description: 'waits for its invocation to end',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				timeoutMs: 2_000,
				execute: async (_input, context) => {
					childSignal = context.abortSignal
					markChildStarted?.()
					await Promise.race([
						childRelease,
						new Promise<void>((resolve) => {
							if (context.abortSignal.aborted) resolve()
							else
								context.abortSignal.addEventListener('abort', () => resolve(), {
									once: true,
								})
						}),
					])
					return {
						success: false,
						output: '',
						error: 'child invocation ended',
					}
				},
			}),
		)
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [call('parent', 'fire_and_forget', {})] }, { text: 'done' }],
		})

		try {
			const startedAt = Date.now()
			await drainQuery(params(provider, tools), (event) => {
				events.push(event)
			})
			expect(Date.now() - startedAt).toBeLessThan(500)
			expect(childSignal?.aborted).toBe(true)
			expect((childSignal?.reason as Error | undefined)?.message).toMatch(
				/fire_and_forget.*invocation has settled/i,
			)
			const nestedDone = events.findIndex(
				(event) =>
					event.type === 'tool_completed' &&
					event.toolName === 'held_child' &&
					event.via !== undefined,
			)
			const parentDone = events.findIndex(
				(event) => event.type === 'tool_completed' && event.toolUseId === 'parent',
			)
			expect(nestedDone).toBeGreaterThanOrEqual(0)
			expect(parentDone).toBeGreaterThan(nestedDone)
		} finally {
			releaseChild?.()
		}
	})

	it('cannot use an allowed parent to execute a child the operator denied', async () => {
		let shellExecutions = 0
		const events: RunEvent[] = []
		const runStore = new InMemoryRunStore()
		const tools = new ToolRegistry()
		tools.register(buildRunCodeTool({ timeoutMs: 2_000 }))
		tools.register(
			defineTool({
				name: 'shell',
				description: 'side-effecting shell fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					shellExecutions++
					return { success: true, output: 'executed' }
				},
			}),
		)
		const gate: AuthorizationGateConfig = {
			enabled: true,
			rules: [
				{ type: 'allow_by_name', toolNames: ['run_code'] },
				{ type: 'deny_by_name', toolNames: ['shell'] },
			],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		}
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						call('parent', 'run_code', {
							code: 'return await call("shell", { command: "forbidden" })',
							tools: ['shell'],
						}),
					],
				},
				{ text: 'the child was refused' },
			],
		})

		await drainQuery(
			{
				...params(provider, tools),
				authorizationGate: gate,
				runStore,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(shellExecutions).toBe(0)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolName: 'shell',
				isError: true,
				via: expect.objectContaining({ tool: 'run_code', toolUseId: 'parent' }),
				result: expect.stringMatching(/authorization gate/i),
			}),
		)
		const audit = await runStore.readAuditEvents()
		expect(audit).toContainEqual(
			expect.objectContaining({
				what: { action: 'tool_call', tool: 'shell' },
				outcome: 'refused',
				reason: expect.stringMatching(/denied by name/i),
			}),
		)
	})

	it('fails an undecided nested call closed instead of bypassing durable review', async () => {
		let effects = 0
		const runStore = new InMemoryRunStore()
		const tools = new ToolRegistry()
		tools.register(
			parentTool(
				'nested_parent',
				async (context) => {
					const result = await context.dispatchTool?.('late_effect', {})
					return result ?? { success: false, output: 'dispatch unavailable' }
				},
				1_000,
			),
		)
		tools.register(lateTool(() => effects++))
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [call('parent', 'nested_parent', {})] },
				{ text: 'the nested review was refused' },
			],
		})

		await drainQuery({
			...params(provider, tools),
			runStore,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['nested_parent'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})

		expect(effects).toBe(0)
		expect(await runStore.readAuditEvents()).toContainEqual(
			expect.objectContaining({
				what: { action: 'tool_call', tool: 'late_effect' },
				outcome: 'refused',
				reason: expect.stringMatching(/requires an explicit allow rule/i),
			}),
		)
	})

	it('applies pre-tool rewrites before authorizing a nested call', async () => {
		let shellExecutions = 0
		const runStore = new InMemoryRunStore()
		const tools = new ToolRegistry()
		tools.register(buildRunCodeTool({ timeoutMs: 2_000 }))
		tools.register(
			defineTool({
				name: 'shell',
				description: 'nested hook fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					shellExecutions++
					return { success: true, output: 'executed' }
				},
			}),
		)
		const pluginManager = {
			executeHooks: async (event: string, context: { toolName?: string }) =>
				event === 'pre_tool_use' && context.toolName === 'shell'
					? [{ action: 'modify', input: { command: 'git push origin main' } }]
					: [],
		} as unknown as PluginLifecycleManager
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						call('parent', 'run_code', {
							code: 'return await call("shell", { command: "status" })',
							tools: ['shell'],
						}),
					],
				},
				{ text: 'done' },
			],
		})

		await drainQuery({
			...params(provider, tools),
			runStore,
			pluginManager,
			authorizationGate: {
				enabled: true,
				rules: [
					{
						type: 'custom_pattern',
						pattern: 'git push',
						target: 'args',
						decision: 'deny',
					},
					{ type: 'allow_by_name', toolNames: ['run_code', 'shell'] },
				],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})

		expect(shellExecutions).toBe(0)
		expect(await runStore.readAuditEvents()).toContainEqual(
			expect.objectContaining({
				what: { action: 'tool_call', tool: 'shell' },
				outcome: 'refused',
				reason: expect.stringMatching(/git push/i),
			}),
		)
	})

	it('executes the detached value even when a nested caller mutates its input after dispatch', async () => {
		const executed: unknown[] = []
		const tools = new ToolRegistry()
		tools.register(
			parentTool(
				'aliasing_parent',
				async (context) => {
					const callerOwned = { command: 'status' }
					const pending = context.dispatchTool?.('shell', callerOwned)
					callerOwned.command = 'git push origin main'
					return (await pending) ?? { success: false, output: 'dispatch unavailable' }
				},
				1_000,
			),
		)
		tools.register(
			defineTool({
				name: 'shell',
				description: 'nested alias fixture',
				inputSchema: z.any(),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async (input) => {
					executed.push(input)
					return { success: true, output: 'executed' }
				},
			}),
		)
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [call('parent', 'aliasing_parent', {})] }, { text: 'done' }],
		})

		await drainQuery({
			...params(provider, tools),
			authorizationGate: {
				enabled: true,
				rules: [
					{
						type: 'custom_pattern',
						pattern: 'git push',
						target: 'args',
						decision: 'deny',
					},
					{ type: 'allow_by_name', toolNames: ['aliasing_parent', 'shell'] },
				],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})

		expect(executed).toEqual([{ command: 'status' }])
	})

	it('applies the probe veto to nested calls too', async () => {
		let effects = 0
		const events: RunEvent[] = []
		const tools = new ToolRegistry()
		tools.register(buildRunCodeTool({ timeoutMs: 2_000 }))
		tools.register(
			defineTool({
				name: 'nested_probe_effect',
				description: 'nested probe fixture',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					effects++
					return { success: true, output: 'executed' }
				},
			}),
		)
		const removeVeto = probe.veto(
			'tool_executing',
			() => ({ action: 'deny', reason: 'nested probe refusal' }),
			{
				name: `nested-probe-${Math.random()}`,
				where: (event) => event.toolName === 'nested_probe_effect',
			},
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						call('parent', 'run_code', {
							code: 'return await call("nested_probe_effect", {})',
							tools: ['nested_probe_effect'],
						}),
					],
				},
				{ text: 'done' },
			],
		})

		try {
			await drainQuery(params(provider, tools), (event) => {
				events.push(event)
			})
		} finally {
			removeVeto()
		}

		expect(effects).toBe(0)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolName: 'nested_probe_effect',
				isError: true,
				result: expect.stringMatching(/nested probe refusal/i),
				via: expect.objectContaining({ tool: 'run_code' }),
			}),
		)
	})

	it('cancels a held nested pre-tool hook with its parent invocation', async () => {
		let shellExecutions = 0
		let hookSignal: AbortSignal | undefined
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		const tools = new ToolRegistry()
		const runCode = buildRunCodeTool({ timeoutMs: 2_000 })
		tools.register({ ...runCode, timeoutMs: 250 })
		tools.register(
			defineTool({
				name: 'shell',
				description: 'held nested hook fixture',
				inputSchema: z.object({ command: z.string() }),
				category: 'shell',
				permissions: ['shell_execute'],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async () => {
					shellExecutions++
					return { success: true, output: 'executed' }
				},
			}),
		)
		const pluginManager = {
			executeHooks: async (event: string, context: { toolName?: string; signal?: AbortSignal }) => {
				if (event !== 'pre_tool_use' || context.toolName !== 'shell') return []
				hookSignal = context.signal
				enter()
				await new Promise<never>((_resolve, reject) => {
					const signal = context.signal
					if (!signal) return
					if (signal.aborted) reject(signal.reason)
					else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
				})
				return []
			},
		} as unknown as PluginLifecycleManager
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						call('parent', 'run_code', {
							code: 'return await call("shell", { command: "status" })',
							tools: ['shell'],
						}),
					],
				},
				{ text: 'parent timeout handled' },
			],
		})

		const pending = drainQuery({
			...params(provider, tools),
			pluginManager,
		})
		await entered
		const safety = Symbol('nested hook remained live')
		const result = await Promise.race([
			pending,
			new Promise<typeof safety>((resolve) => setTimeout(() => resolve(safety), 1_500)),
		])

		expect(result).not.toBe(safety)
		expect(hookSignal?.aborted).toBe(true)
		expect((hookSignal?.reason as Error | undefined)?.message).toMatch(/run_code.*exceeded 250ms/i)
		expect(shellExecutions).toBe(0)
	})
})
