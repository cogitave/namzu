import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { PluginRegistry } from '../../registry/plugin/index.js'
import type { SessionId } from '../../types/ids/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { definePlugin } from '../define.js'
import { PluginLifecycleManager } from '../lifecycle.js'

function manager() {
	return new PluginLifecycleManager({
		pluginRegistry: new PluginRegistry(),
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: NOOP_LOGGER,
	})
}

describe('definePlugin', () => {
	it('installs, enables, disables and uninstalls in-code tools, hooks and instructions', async () => {
		const hook = vi.fn(async () => ({ action: 'continue' as const }))
		const plugin = definePlugin({
			name: 'inline',
			tools: [
				{
					name: 'probe',
					description: 'Probe the host',
					inputSchema: z.object({}),
					execute: async () => ({ success: true, output: 'ok' }),
				},
			],
			hooks: [{ event: 'pre_tool_use', handler: hook }],
			instructions: 'Use probe sparingly.',
		})
		const runtime = manager()
		const installed = runtime.installDefined(plugin)
		expect(runtime.toolsets.map((entry) => entry.source.id)).toEqual(['plugin:inline'])
		expect(runtime.toolsets[0]?.tools()).toEqual([])

		await runtime.enable(installed.id)
		expect(runtime.toolsets[0]?.tools().map((tool) => tool.name)).toEqual(['inline__probe'])
		await runtime.executeHooks('pre_tool_use', { sessionId: 'session' as SessionId })
		expect(hook).toHaveBeenCalledOnce()
		expect(runtime.promptContributions[0]?.render({})).toContain('Use probe sparingly.')

		await runtime.disable(installed.id)
		expect(runtime.toolsets[0]?.tools()).toEqual([])
		expect(runtime.promptContributions).toEqual([])
		await runtime.executeHooks('pre_tool_use', { sessionId: 'session' as SessionId })
		expect(hook).toHaveBeenCalledOnce()

		await runtime.uninstall(installed.id)
		expect(runtime.toolsets).toEqual([])
	})

	it('validates the manifest name and hook events before registration', () => {
		expect(() => definePlugin({ name: 'Bad Name' })).toThrow()
		expect(() =>
			definePlugin({
				name: 'valid',
				hooks: [{ event: 'run_start' as never, handler: async () => ({ action: 'continue' }) }],
			}),
		).toThrow()
	})
})
