import { describe, expect, it, vi } from 'vitest'

import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { PluginRegistry } from '../../../registry/plugin/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { PluginId } from '../../../types/ids/index.js'
import type { PluginHookContext, PluginHookResult } from '../../../types/plugin/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { drainQuery } from '../index.js'

function logger(): Logger {
	const make = (): Logger =>
		({
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			child: vi.fn(() => make()),
		}) as unknown as Logger
	return make()
}

describe('plugin hook cancellation reaches a real query', () => {
	it('settles before a held pre-model hook is released and never calls the provider', async () => {
		const caller = new AbortController()
		const reason = new Error('operator stopped the run')
		const provider = new MockLLMProvider({
			responseText: 'must not be requested',
		})
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			toolRegistry: new ToolRegistry(),
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
			hookTimeoutMs: 10_000,
		})
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		let release!: (result: PluginHookResult) => void
		const held = new Promise<PluginHookResult>((resolve) => {
			release = resolve
		})
		let hookSignal: AbortSignal | undefined
		manager.registerHook('plugin_cancel' as PluginId, {
			event: 'pre_llm_call',
			handler: (context: PluginHookContext) => {
				hookSignal = context.signal
				enter()
				return held
			},
		})
		const events: RunEvent[] = []
		const runPromise = drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				pluginManager: manager,
				runConfig: {
					model: 'mock-model',
					timeoutMs: 30_000,
					tokenBudget: 100_000,
					maxIterations: 2,
					maxResponseTokens: 256,
				},
				agentId: 'agent_plugin_cancel',
				agentName: 'Plugin cancellation observer',
				messages: [{ role: 'user', content: 'do not reach the model' }],
				workingDirectory: process.cwd(),
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				signal: caller.signal,
			},
			(event) => {
				events.push(event)
			},
		)

		await entered
		caller.abort(reason)
		const safety = Symbol('still waiting for the held hook')
		const outcome = await Promise.race([
			runPromise,
			new Promise<typeof safety>((resolve) => setTimeout(() => resolve(safety), 250)),
		])
		try {
			expect(outcome).not.toBe(safety)
			if (outcome === safety) return
			expect(outcome.status).toBe('cancelled')
			expect(provider.requests).toHaveLength(0)
			expect(hookSignal?.aborted).toBe(true)
			expect(hookSignal?.reason).toBe(reason)
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'plugin_hook_executing',
					hookEvent: 'pre_llm_call',
				}),
			)
			expect(events).not.toContainEqual(
				expect.objectContaining({
					type: 'plugin_hook_completed',
					hookEvent: 'pre_llm_call',
				}),
			)
		} finally {
			release({ action: 'continue' })
			await runPromise
		}
	})
})
