/**
 * Current-code invariants asserted (2026-07-12, ses_016):
 *
 *   - A throwing (or timing-out) hook handler still defaults to fail-CLOSED:
 *     the result is `{ action: 'error' }`, which the executor turns into a
 *     blocked tool call. That is the pre-ses_016 behavior, preserved.
 *   - A hook registered with `onError: 'continue'` does not block: its throw is
 *     converted to `{ action: 'continue' }` and the chain proceeds to the next
 *     handler.
 *   - A `'continue'` outcome is NOT a clean outcome. The error is logged, and it
 *     is carried on the `plugin_hook_completed` run event's `error` field — a
 *     crashed observer must not be indistinguishable from one that ran fine.
 *   - The policy is retained where the handler is stored: it survives the copy
 *     into `hookHandlers` made at enable time.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PluginRegistry } from '../../registry/plugin/index.js'
import type { PluginId, RunId } from '../../types/ids/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'

const runId = 'run_test' as RunId

function makeLogger(): { log: Logger; error: ReturnType<typeof vi.fn> } {
	const error = vi.fn()
	const s = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() }
	const log = { ...s, child: vi.fn(() => ({ ...s, child: vi.fn() })) } as unknown as Logger
	return { log, error }
}

function makeManager(log: Logger): PluginLifecycleManager {
	return new PluginLifecycleManager({
		pluginRegistry: {} as unknown as PluginRegistry,
		toolRegistry: {} as unknown as ToolRegistryContract,
		log,
	})
}

describe('plugin hook onError policy', () => {
	it('fails closed by default: a throwing handler yields an error result', async () => {
		const { log } = makeLogger()
		const mgr = makeManager(log)
		const next = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))

		mgr['hookHandlers'].set('pre_tool_use', [
			{
				pluginId: 'plugin_1' as PluginId,
				handler: vi.fn(async () => {
					throw new Error('handler exploded')
				}),
			},
			{ pluginId: 'plugin_2' as PluginId, handler: next },
		])

		const results = await mgr.executeHooks('pre_tool_use', { runId })

		expect(results).toHaveLength(1)
		expect(results[0]).toEqual({ action: 'error', message: 'handler exploded' })
		// error short-circuits the chain
		expect(next).not.toHaveBeenCalled()
	})

	it('does not block when the handler declared onError: "continue"', async () => {
		const { log } = makeLogger()
		const mgr = makeManager(log)
		const next = vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' }))

		mgr['hookHandlers'].set('pre_tool_use', [
			{
				pluginId: 'plugin_1' as PluginId,
				handler: vi.fn(async () => {
					throw new Error('observer exploded')
				}),
				onError: 'continue',
			},
			{ pluginId: 'plugin_2' as PluginId, handler: next },
		])

		const results = await mgr.executeHooks('pre_tool_use', { runId })

		expect(results[0]).toEqual({ action: 'continue' })
		expect(next).toHaveBeenCalledOnce()
	})

	it('keeps the error visible on telemetry and in the log when it continues', async () => {
		const { log, error } = makeLogger()
		const mgr = makeManager(log)
		const events: RunEvent[] = []

		mgr['hookHandlers'].set('post_tool_use', [
			{
				pluginId: 'plugin_1' as PluginId,
				handler: vi.fn(async () => {
					throw new Error('observer exploded')
				}),
				onError: 'continue',
			},
		])

		await mgr.executeHooks('post_tool_use', { runId }, async (e) => {
			events.push(e)
		})

		const completed = events.find((e) => e.type === 'plugin_hook_completed')
		expect(completed).toBeDefined()
		// A crashed hook must not look like a clean one, even though it did not block.
		expect(completed).toMatchObject({
			result: { action: 'continue' },
			error: 'observer exploded',
		})
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('continuing'),
			expect.objectContaining({ error: 'observer exploded' }),
		)
	})

	it('leaves the error field unset when the hook ran cleanly', async () => {
		const { log } = makeLogger()
		const mgr = makeManager(log)
		const events: RunEvent[] = []

		mgr['hookHandlers'].set('post_tool_use', [
			{
				pluginId: 'plugin_1' as PluginId,
				handler: vi.fn(async (): Promise<PluginHookResult> => ({ action: 'continue' })),
				onError: 'continue',
			},
		])

		await mgr.executeHooks('post_tool_use', { runId }, async (e) => {
			events.push(e)
		})

		const completed = events.find((e) => e.type === 'plugin_hook_completed')
		expect(completed).toMatchObject({ result: { action: 'continue' } })
		expect((completed as { error?: string }).error).toBeUndefined()
	})

	it('reports the error on telemetry under the default policy too', async () => {
		const { log } = makeLogger()
		const mgr = makeManager(log)
		const events: RunEvent[] = []

		mgr['hookHandlers'].set('pre_tool_use', [
			{
				pluginId: 'plugin_1' as PluginId,
				handler: vi.fn(async () => {
					throw new Error('boom')
				}),
			},
		])

		await mgr.executeHooks('pre_tool_use', { runId }, async (e) => {
			events.push(e)
		})

		const completed = events.find((e) => e.type === 'plugin_hook_completed')
		expect(completed).toMatchObject({
			result: { action: 'error', message: 'boom' },
			error: 'boom',
		})
	})
})
