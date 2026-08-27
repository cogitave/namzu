import { describe, expect, it } from 'vitest'
import { z } from 'zod'

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
})
