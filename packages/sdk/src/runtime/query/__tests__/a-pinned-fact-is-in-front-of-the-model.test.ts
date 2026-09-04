import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A pin exists to be seen. After a tool pins a fact, the next request the
 * model receives carries it in the working-memory slot — not only after
 * a compaction pass, and not only in a summary.
 */

registerMock()

describe('a fact a tool pinned', () => {
	it('is in the next model request, in the working-memory slot', async () => {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'probe',
				description: 'probes',
				inputSchema: z.object({}),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({
					success: true,
					output: 'ACTION1 moved the piece up',
					workingState: [{ key: 'controls', text: 'ACTION1 = up' }],
				}),
			}),
		)
		const call: MockTurn = {
			toolCalls: [{ id: 'c1', name: 'probe', args: {} }],
			finishReason: 'tool_calls',
		}
		const requests: string[][] = []
		const manager = {
			executeHooks: async (
				event: PluginHookEvent,
				ctx: Omit<PluginHookContext, 'pluginId' | 'event'>,
			) => {
				if (event === 'pre_llm_call' && ctx.request) {
					requests.push(
						ctx.request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
					)
				}
				return []
			},
		} as unknown as PluginLifecycleManager
		await drainQuery({
			provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
			tools,
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'probe it' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			compactionConfig: CompactionConfigSchema.parse({}),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
		})
		expect(requests.length).toBeGreaterThanOrEqual(2)
		const second = requests[1]?.join('\n') ?? ''
		expect(second).toContain('## Pinned by tools')
		expect(second).toContain('**controls**: ACTION1 = up _(probe)_')
		expect(requests[0]?.join('\n')).not.toContain('Pinned by tools')
	})
})
