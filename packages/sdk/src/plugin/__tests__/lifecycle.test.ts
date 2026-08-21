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

		// `child()` returns a Logger, and a Logger has `child` — so a stub whose
		// child is a leaf breaks the moment production binds a scope on a scope,
		// which it now does. A fixture unlike production tests a system that
		// does not ship; this one is recursive the way the real thing is.
		const makeLogger = (): Logger => {
			const self = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				child: vi.fn(() => makeLogger()),
			}
			return self as unknown as Logger
		}
		logger = {
			child: vi.fn(() => makeLogger()),
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
			manager.registerHook('plugin_1' as PluginId, {
				event: 'run_start',
				handler: hook1Handler,
			})
			manager.registerHook('plugin_2' as PluginId, {
				event: 'run_start',
				handler: hook2Handler,
			})

			const results = await manager.executeHooks('run_start', { runId: mockRunId })

			expect(results).toHaveLength(2)
			expect(hook1Handler).toHaveBeenCalled()
			expect(hook2Handler).toHaveBeenCalled()
		})

		it('refuses a pre-aborted run before a hook or event starts', async () => {
			const reason = new Error('operator stopped before the hook')
			const caller = new AbortController()
			caller.abort(reason)
			const handler = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))
			const emitRunEvent = vi.fn(async () => {})
			manager.registerHook(mockPluginId, { event: 'pre_llm_call', handler })

			await expect(
				manager.executeHooks(
					'pre_llm_call',
					{ runId: mockRunId, signal: caller.signal },
					emitRunEvent,
				),
			).rejects.toBe(reason)
			expect(handler).not.toHaveBeenCalled()
			expect(emitRunEvent).not.toHaveBeenCalled()
		})

		it('propagates caller cancellation even when the hook ignores its signal', async () => {
			const reason = new Error('operator stopped during the hook')
			const caller = new AbortController()
			let enter!: () => void
			const entered = new Promise<void>((resolve) => {
				enter = resolve
			})
			let release!: (result: PluginHookResult) => void
			const held = new Promise<PluginHookResult>((resolve) => {
				release = resolve
			})
			let hookSignal: AbortSignal | undefined
			const handler = vi.fn((context: PluginHookContext) => {
				hookSignal = context.signal
				enter()
				return held
			})
			const emitted: string[] = []
			manager.registerHook(mockPluginId, { event: 'pre_llm_call', handler })

			const execution = manager.executeHooks(
				'pre_llm_call',
				{ runId: mockRunId, signal: caller.signal },
				async (event) => {
					emitted.push(event.type)
				},
			)
			await entered
			caller.abort(reason)

			const safety = Symbol('hook cancellation did not settle')
			const outcome = await Promise.race([
				execution.then(
					(value) => ({ kind: 'resolved' as const, value }),
					(error: unknown) => ({ kind: 'rejected' as const, error }),
				),
				new Promise<typeof safety>((resolve) => setTimeout(() => resolve(safety), 250)),
			])
			try {
				expect(outcome).not.toBe(safety)
				if (outcome === safety) return
				expect(outcome.kind).toBe('rejected')
				if (outcome.kind === 'rejected') expect(outcome.error).toBe(reason)
				expect(hookSignal?.aborted).toBe(true)
				expect(hookSignal?.reason).toBe(reason)
				expect(emitted).toEqual(['plugin_hook_executing'])

				release({ action: 'continue' })
				await Promise.resolve()
				expect(emitted).toEqual(['plugin_hook_executing'])
			} finally {
				release({ action: 'continue' })
				await execution.catch(() => {})
			}
		})

		it('should handle hook timeout', async () => {
			const slowHandler = vi.fn(
				() =>
					new Promise<PluginHookResult>((resolve) => {
						setTimeout(() => resolve({ action: 'continue' }), 10000)
					}),
			)

			manager.registerHook(mockPluginId, {
				event: 'run_start',
				handler: slowHandler,
			})

			const managerWithShortTimeout = new PluginLifecycleManager({
				pluginRegistry,
				toolRegistry,
				log: logger,
				hookTimeoutMs: 10, // Very short timeout
			})

			managerWithShortTimeout.registerHook(mockPluginId, {
				event: 'run_start',
				handler: slowHandler,
			})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'pre_tool_use',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'pre_tool_use',
					handler: handler2,
				})
				manager.registerHook('plugin_3' as PluginId, {
					event: 'pre_tool_use',
					handler: handler3,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'post_tool_use',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'post_tool_use',
					handler: handler2,
				})
				manager.registerHook('plugin_3' as PluginId, {
					event: 'post_tool_use',
					handler: handler3,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'run_start',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'run_start',
					handler: handler2,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'run_start',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'run_start',
					handler: handler2,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'pre_tool_use',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'pre_tool_use',
					handler: handler2,
				})

				const results = await manager.executeHooks('pre_tool_use', { runId: mockRunId })

				expect(results).toHaveLength(1)
				expect(results[0]?.action).toBe('skip')
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
				manager.registerHook('plugin_1' as PluginId, {
					event: 'pre_llm_call',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'pre_llm_call',
					handler: handler2,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'pre_tool_use',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'pre_tool_use',
					handler: handler2,
				})

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

				manager.registerHook('plugin_1' as PluginId, {
					event: 'iteration_start',
					handler: handler1,
				})
				manager.registerHook('plugin_2' as PluginId, {
					event: 'iteration_start',
					handler: handler2,
				})

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

				manager.registerHook(mockPluginId, { event: 'pre_tool_use', handler })

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

				manager.registerHook(mockPluginId, { event: 'iteration_end', handler })

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

				manager.registerHook(mockPluginId, { event: 'run_start', handler })

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

				manager.registerHook(mockPluginId, { event: 'run_start', handler })

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

				manager.registerHook(mockPluginId, { event: 'run_start', handler })

				const executePromise = manager.executeHooks('run_start', { runId: mockRunId })
				await expect(executePromise).resolves.not.toThrow()
			})
		})

		describe('RunEvent emission', () => {
			it('should emit plugin_hook_executing and plugin_hook_completed when emitRunEvent provided', async () => {
				const emitted: any[] = []
				const emitRunEvent = vi.fn(async (event: any) => {
					emitted.push(event)
				})

				const handler = vi.fn(
					async (): Promise<PluginHookResult> => ({ action: 'modify', input: { x: 1 } }),
				)

				manager.registerHook(mockPluginId, { event: 'pre_tool_use', handler })

				await manager.executeHooks(
					'pre_tool_use',
					{ runId: mockRunId, toolName: 't', toolInput: {} },
					emitRunEvent,
				)

				expect(emitted).toHaveLength(2)
				expect(emitted[0]).toMatchObject({
					type: 'plugin_hook_executing',
					runId: mockRunId,
					pluginId: mockPluginId,
					hookEvent: 'pre_tool_use',
				})
				expect(emitted[1]).toMatchObject({
					type: 'plugin_hook_completed',
					runId: mockRunId,
					pluginId: mockPluginId,
					hookEvent: 'pre_tool_use',
				})
				expect(emitted[1].result).toEqual({ action: 'modify', input: { x: 1 } })
			})

			it('should not emit RunEvents when emitRunEvent omitted', async () => {
				const handler = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))
				manager.registerHook(mockPluginId, { event: 'run_start', handler })
				await expect(manager.executeHooks('run_start', { runId: mockRunId })).resolves.toHaveLength(
					1,
				)
			})
		})
	})
})
