import { describe, expect, it, vi } from 'vitest'

import type { PluginId, RunId } from '../../types/ids/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import { PluginLifecycleManager } from '../lifecycle.js'

/**
 * Hook order was install order — neither declared nor stable, since it
 * depends on when each plugin happened to be installed. That is fine for a
 * hook that only observes and wrong for one that decides: `executeHooks`
 * SHORT-CIRCUITS on `skip` and `error`, so a hook that denies a dangerous
 * command only gets to deny it if it runs before whatever else stops the
 * chain. A guard whose firing depends on installation history is not a
 * guard.
 */

const RUN_ID = 'run_x' as RunId

function makeLogger(): never {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: () => logger,
	}
	return logger as never
}

function makeManager(hookTimeoutMs?: number) {
	return new PluginLifecycleManager({
		pluginRegistry: {} as never,
		toolRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: makeLogger(),
		...(hookTimeoutMs !== undefined ? { hookTimeoutMs } : {}),
	})
}

const record = (order: string[], name: string, result?: PluginHookResult) => async () => {
	order.push(name)
	return result ?? ({ action: 'continue' } as PluginHookResult)
}

describe('priority', () => {
	it('runs a lower priority first, whatever order it was registered in', async () => {
		const order: string[] = []
		const manager = makeManager()
		manager.registerHook('p_late' as PluginId, {
			event: 'pre_tool_use',
			priority: 900,
			handler: record(order, 'observer'),
		})
		manager.registerHook('p_guard' as PluginId, {
			event: 'pre_tool_use',
			priority: 10,
			handler: record(order, 'guard'),
		})

		await manager.executeHooks('pre_tool_use', { runId: RUN_ID })
		expect(order).toEqual(['guard', 'observer'])
	})

	it('lets a guard deny before anything downstream can stop the chain', async () => {
		const order: string[] = []
		const manager = makeManager()
		// Registered first, so under install order it would have run first
		// and short-circuited before the guard ever saw the call.
		manager.registerHook('p_other' as PluginId, {
			event: 'pre_tool_use',
			handler: record(order, 'other', { action: 'skip', reason: 'unrelated' }),
		})
		manager.registerHook('p_guard' as PluginId, {
			event: 'pre_tool_use',
			priority: 1,
			handler: record(order, 'guard', { action: 'error', message: 'denied' }),
		})

		const results = await manager.executeHooks('pre_tool_use', { runId: RUN_ID })
		expect(order).toEqual(['guard'])
		expect(results).toEqual([{ action: 'error', message: 'denied' }])
	})

	it('keeps registration order for equal priorities', async () => {
		const order: string[] = []
		const manager = makeManager()
		for (const name of ['a', 'b', 'c']) {
			manager.registerHook(`p_${name}` as PluginId, {
				event: 'iteration_start',
				handler: record(order, name),
			})
		}

		// A plugin that never sets a priority behaves exactly as before.
		await manager.executeHooks('iteration_start', { runId: RUN_ID })
		expect(order).toEqual(['a', 'b', 'c'])
	})

	it('unwinds a post hook in the opposite order, so a guard closes last', async () => {
		const order: string[] = []
		const manager = makeManager()
		// Registered observer-first on purpose: under plain registration
		// order the reversal alone would already produce the expected
		// result, and the assertion would hold with no sorting at all.
		manager.registerHook('p_observer' as PluginId, {
			event: 'post_tool_use',
			priority: 900,
			handler: record(order, 'observer'),
		})
		manager.registerHook('p_guard' as PluginId, {
			event: 'post_tool_use',
			priority: 1,
			handler: record(order, 'guard'),
		})

		// Post hooks unwind, so whichever opened first closes last — the
		// wrapping order a guard needs.
		await manager.executeHooks('post_tool_use', { runId: RUN_ID })
		expect(order).toEqual(['observer', 'guard'])
	})

	it('composes modify in priority order', async () => {
		const seen: unknown[] = []
		const manager = makeManager()
		manager.registerHook('p_second' as PluginId, {
			event: 'pre_tool_use',
			priority: 200,
			handler: async (ctx) => {
				seen.push(ctx.toolInput)
				return { action: 'modify', input: { ...(ctx.toolInput as object), second: true } }
			},
		})
		manager.registerHook('p_first' as PluginId, {
			event: 'pre_tool_use',
			priority: 100,
			handler: async (ctx) => {
				seen.push(ctx.toolInput)
				return { action: 'modify', input: { ...(ctx.toolInput as object), first: true } }
			},
		})

		const results = await manager.executeHooks('pre_tool_use', {
			runId: RUN_ID,
			toolInput: { base: true },
		})

		// What each hook SAW, not just the merged result: the merged object
		// is identical either way round, so asserting on it alone would hold
		// with no ordering at all.
		expect(seen).toEqual([{ base: true }, { base: true, first: true }])
		expect(results.at(-1)).toEqual({
			action: 'modify',
			input: { base: true, first: true, second: true },
		})
	})
})

describe('the deadline timer', () => {
	it('does not keep a timer armed after the hook resolves', async () => {
		const manager = makeManager(60_000)
		manager.registerHook('p' as PluginId, {
			event: 'run_start',
			handler: async () => ({ action: 'continue' }),
		})

		vi.useFakeTimers()
		try {
			await manager.executeHooks('run_start', { runId: RUN_ID })
			// An armed timer keeps the Node event loop alive. Hooks fire on
			// every tool call and every model call, so a leak here meant a
			// short run could not exit until the last deadline expired.
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('clears the timer even when the hook throws', async () => {
		const manager = makeManager(60_000)
		manager.registerHook('p' as PluginId, {
			event: 'run_start',
			handler: async () => {
				throw new Error('boom')
			},
		})

		vi.useFakeTimers()
		try {
			const results = await manager.executeHooks('run_start', { runId: RUN_ID })
			expect(results[0]?.action).toBe('error')
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('leaves nothing armed across a chain of hooks', async () => {
		const manager = makeManager(60_000)
		for (let i = 0; i < 5; i++) {
			manager.registerHook(`p${i}` as PluginId, {
				event: 'iteration_start',
				handler: async () => ({ action: 'continue' }),
			})
		}

		vi.useFakeTimers()
		try {
			await manager.executeHooks('iteration_start', { runId: RUN_ID })
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it('tells a slow hook it was abandoned instead of only walking away', async () => {
		const manager = makeManager(5)
		let aborted = false
		manager.registerHook('p' as PluginId, {
			event: 'run_start',
			handler: async (ctx) => {
				ctx.signal?.addEventListener('abort', () => {
					aborted = true
				})
				await new Promise((resolve) => setTimeout(resolve, 100))
				return { action: 'continue' }
			},
		})

		const results = await manager.executeHooks('run_start', { runId: RUN_ID })
		expect(results[0]).toEqual({ action: 'error', message: 'Hook timeout' })
		// Without this the hook never learns it was dropped, and an HTTP
		// request inside it keeps a socket open for a run that moved on.
		expect(aborted).toBe(true)
	})

	it('does not abort a hook that finished in time', async () => {
		const manager = makeManager(10_000)
		let aborted = false
		manager.registerHook('p' as PluginId, {
			event: 'run_start',
			handler: async (ctx) => {
				ctx.signal?.addEventListener('abort', () => {
					aborted = true
				})
				return { action: 'continue' }
			},
		})

		await manager.executeHooks('run_start', { runId: RUN_ID })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(aborted).toBe(false)
	})
})
