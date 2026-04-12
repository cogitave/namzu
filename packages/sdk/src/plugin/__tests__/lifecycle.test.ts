import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId, RunId } from '../../types/ids/index.js'
import type { PluginHookContext, PluginHookResult } from '../../types/plugin/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'

describe('PluginLifecycleManager', () => {
	let manager: PluginLifecycleManager
	let pluginRegistry: PluginRegistry
	let toolRegistry: ToolRegistryContract
	let logger: Logger

	const mockRunId = 'run_test' as RunId
	const mockPluginId = 'plugin_test' as PluginId

	beforeEach(() => {
		// Create mock registries and logger
		pluginRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			getOrThrow: vi.fn(),
			findByName: vi.fn(),
			getAll: vi.fn(() => []),
		} as any

		toolRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			execute: vi.fn(),
			getAll: vi.fn(() => []),
		} as any

		logger = {
			child: vi.fn(() => ({
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			})),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as any

		manager = new PluginLifecycleManager({
			pluginRegistry,
			toolRegistry,
			log: logger,
			hookTimeoutMs: 5000,
		})
	})

	describe('executeHooks', () => {
		it('should return empty array when no hooks registered', async () => {
			const results = await manager.executeHooks('run_start', { runId: mockRunId })
			expect(results).toEqual([])
		})

		it('should execute all registered hooks for an event', async () => {
			const hook1Handler = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))
			const hook2Handler = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))

			// Register hooks manually
			manager['hookHandlers'].set('run_start', [
				{ pluginId: 'plugin_1' as PluginId, handler: hook1Handler },
				{ pluginId: 'plugin_2' as PluginId, handler: hook2Handler },
			])

			const results = await manager.executeHooks('run_start', { runId: mockRunId })

			expect(results).toHaveLength(2)
			expect(hook1Handler).toHaveBeenCalled()
			expect(hook2Handler).toHaveBeenCalled()
		})

		it('should handle hook timeout', async () => {
			const slowHandler = vi.fn(
				() =>
					new Promise<PluginHookResult>((resolve) => {
						setTimeout(() => resolve({ action: 'continue' }), 10000)
					}),
			)

			manager['hookHandlers'].set('run_start', [{ pluginId: mockPluginId, handler: slowHandler }])

			const managerWithShortTimeout = new PluginLifecycleManager({
				pluginRegistry,
				toolRegistry,
				log: logger,
				hookTimeoutMs: 10, // Very short timeout
			})

			managerWithShortTimeout['hookHandlers'].set('run_start', [
				{ pluginId: mockPluginId, handler: slowHandler },
			])

			const results = await managerWithShortTimeout.executeHooks('run_start', {
				runId: mockRunId,
			})

			expect(results).toHaveLength(1)
			expect(results[0]?.action).toBe('error')
			if (results[0]?.action === 'error') {
				expect(results[0].message).toContain('timeout')
			}
		})

		describe('Hook ordering semantics', () => {
			it('should execute pre_* hooks in registration order (first registered first)', async () => {
				const executionOrder: string[] = []

				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook1')
					return { action: 'continue' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook2')
					return { action: 'continue' }
				})

				const handler3 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook3')
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('pre_tool_use', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
					{ pluginId: 'plugin_3' as PluginId, handler: handler3 },
				])

				await manager.executeHooks('pre_tool_use', { runId: mockRunId })

				expect(executionOrder).toEqual(['hook1', 'hook2', 'hook3'])
			})

			it('should execute post_* hooks in reverse registration order (last registered first)', async () => {
				const executionOrder: string[] = []

				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook1')
					return { action: 'continue' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook2')
					return { action: 'continue' }
				})

				const handler3 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook3')
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('post_tool_use', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
					{ pluginId: 'plugin_3' as PluginId, handler: handler3 },
				])

				await manager.executeHooks('post_tool_use', { runId: mockRunId })

				// Reverse order: hook3 -> hook2 -> hook1
				expect(executionOrder).toEqual(['hook3', 'hook2', 'hook1'])
			})

			it('should execute non-pre/post hooks in registration order', async () => {
				const executionOrder: string[] = []

				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook1')
					return { action: 'continue' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					executionOrder.push('hook2')
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('run_start', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				await manager.executeHooks('run_start', { runId: mockRunId })

				expect(executionOrder).toEqual(['hook1', 'hook2'])
			})
		})

		describe('Flow control: action priority', () => {
			it('should short-circuit on error action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'error', message: 'Hook failed' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('run_start', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('run_start', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('error')
				expect(handler2).not.toHaveBeenCalled()
			})

			it('should short-circuit on skip action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'skip', reason: 'Condition not met' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('pre_tool_use', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('pre_tool_use', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('skip')
				expect(handler2).not.toHaveBeenCalled()
			})

			it('should short-circuit and return resume action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'resume', input: 'new_input_value' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('pre_llm_call', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('pre_llm_call', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('resume')
				if (results[0]?.action === 'resume') {
					expect(results[0].input).toBe('new_input_value')
				}
				expect(handler2).not.toHaveBeenCalled()
			})

			it('should short-circuit and return retry action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'retry' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				// Use pre_* hook for forward execution order (plugin_1 runs first and short-circuits).
				// post_* hooks run in reverse order for cleanup semantics.
				manager['hookHandlers'].set('pre_llm_call', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('pre_llm_call', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('retry')
				expect(handler2).not.toHaveBeenCalled()
			})

			it('should continue executing on modify action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'modify', input: { updated: true } }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('pre_tool_use', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('pre_tool_use', { runId: mockRunId })

				expect(results).toHaveLength(2)
				expect(results[0]?.action).toBe('modify')
				expect(results[1]?.action).toBe('continue')
				expect(handler2).toHaveBeenCalled()
			})

			it('should continue executing on continue action', async () => {
				const handler1 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				const handler2 = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('iteration_start', [
					{ pluginId: 'plugin_1' as PluginId, handler: handler1 },
					{ pluginId: 'plugin_2' as PluginId, handler: handler2 },
				])

				const results = await manager.executeHooks('iteration_start', { runId: mockRunId })

				expect(results).toHaveLength(2)
				expect(handler1).toHaveBeenCalled()
				expect(handler2).toHaveBeenCalled()
			})
		})

		describe('Hook context', () => {
			it('should pass correct context to hook handler', async () => {
				let capturedContext: PluginHookContext | null = null

				const handler = vi.fn(async (ctx: PluginHookContext): Promise<PluginHookResult> => {
					capturedContext = ctx
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('pre_tool_use', [{ pluginId: mockPluginId, handler }])

				const contextData = {
					runId: mockRunId,
					toolName: 'test_tool',
					toolInput: { key: 'value' },
				}

				await manager.executeHooks('pre_tool_use', contextData)

				expect(capturedContext).not.toBeNull()
				const ctx = capturedContext as unknown as PluginHookContext
				expect(ctx.runId).toBe(mockRunId)
				expect(ctx.pluginId).toBe(mockPluginId)
				expect(ctx.event).toBe('pre_tool_use')
				expect(ctx.toolName).toBe('test_tool')
				expect(ctx.toolInput).toEqual({ key: 'value' })
			})

			it('should include iteration number in context when provided', async () => {
				let capturedContext: PluginHookContext | null = null

				const handler = vi.fn(async (ctx: PluginHookContext): Promise<PluginHookResult> => {
					capturedContext = ctx
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('iteration_end', [{ pluginId: mockPluginId, handler }])

				await manager.executeHooks('iteration_end', {
					runId: mockRunId,
					iteration: 5,
				})

				const ctx = capturedContext as unknown as PluginHookContext
				expect(ctx.iteration).toBe(5)
			})
		})

		describe('Hook execution logging', () => {
			it('should emit hook_executed event with correct metadata', async () => {
				const events: any[] = []
				manager.on((evt) => events.push(evt))

				const handler = vi.fn(async (): Promise<PluginHookResult> => {
					return { action: 'continue' }
				})

				manager['hookHandlers'].set('run_start', [{ pluginId: mockPluginId, handler }])

				await manager.executeHooks('run_start', { runId: mockRunId })

				const hookExecutedEvents = events.filter((evt) => evt.type === 'plugin_hook_executed')
				expect(hookExecutedEvents).toHaveLength(1)

				const event = hookExecutedEvents[0]
				expect(event?.pluginId).toBe(mockPluginId)
				expect(event?.hookEvent).toBe('run_start')
				expect(typeof event?.durationMs).toBe('number')
				expect(event?.durationMs).toBeGreaterThanOrEqual(0)
			})
		})

		describe('Exception handling', () => {
			it('should catch thrown exceptions and return error action', async () => {
				const handler = vi.fn(async (): Promise<PluginHookResult> => {
					throw new Error('Handler crashed')
				})

				manager['hookHandlers'].set('run_start', [{ pluginId: mockPluginId, handler }])

				const results = await manager.executeHooks('run_start', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('error')
				if (results[0]?.action === 'error') {
					expect(results[0].message).toContain('Handler crashed')
				}
			})

			it('should not throw when handler throws', async () => {
				const handler = vi.fn(async (): Promise<PluginHookResult> => {
					throw new Error('Handler failed')
				})

				manager['hookHandlers'].set('run_start', [{ pluginId: mockPluginId, handler }])

				const executePromise = manager.executeHooks('run_start', { runId: mockRunId })
				await expect(executePromise).resolves.not.toThrow()
			})
		})
	})
})
