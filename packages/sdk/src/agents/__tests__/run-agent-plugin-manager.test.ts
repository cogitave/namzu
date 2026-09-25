import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineCapability } from '../../capabilities/index.js'
import { definePlugin } from '../../plugin/define.js'
import { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { PluginRegistry } from '../../registry/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { runAgent } from '../runAgent.js'

registerMock()

describe('runAgent plugin composition', () => {
	it('mounts a caller-owned plugin manager as tools, untrusted context and hooks', async () => {
		const hookTools: string[] = []
		let ran = false
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: NOOP_LOGGER,
		})
		const installed = manager.installDefined(
			definePlugin({
				name: 'audit',
				instructions: 'Plugin supplied audit advice.',
				tools: [
					{
						name: 'probe',
						description: 'Probe audit state.',
						inputSchema: z.object({}),
						execute: async () => {
							ran = true
							return { success: true, output: 'checked' }
						},
					},
				],
				hooks: [
					{
						event: 'pre_tool_use',
						handler: async (context) => {
							if (context.toolName) hookTools.push(context.toolName)
							return { action: 'continue' }
						},
					},
				],
			}),
		)
		await manager.enable(installed.id)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'find', name: 'search_tools', rawArguments: '{"query":"audit__probe"}' },
					],
				},
				{ toolCalls: [{ id: 'probe', name: 'audit__probe', rawArguments: '{}' }] },
				{ text: 'done' },
			],
		})

		const result = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'Check the audit state.',
			pluginManager: manager,
			capabilities: [defineCapability({ id: 'host-guidance', instructions: 'Host rules.' })],
		})

		expect(result.output).toBe('done')
		expect(ran).toBe(true)
		expect(hookTools).toContain('audit__probe')
		expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toContain('search_tools')
		expect(provider.requests[1]?.tools?.map((tool) => tool.function.name)).toContain('audit__probe')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('Host rules.')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
			'Plugin supplied audit advice.',
		)
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('plugin-instructions')
		const pluginContext = provider.requests[0]?.messages.find((message) =>
			JSON.stringify(message.content).includes('Plugin supplied audit advice.'),
		)
		expect(pluginContext).toMatchObject({
			role: 'user',
			source: { type: 'runtime-context', kind: 'step-context' },
		})
		expect(manager.toolsets[0]?.tools().map((tool) => tool.name)).toContain('audit__probe')
		await manager.disable(installed.id)
		expect(manager.toolsets[0]?.tools()).toEqual([])
	})
})
