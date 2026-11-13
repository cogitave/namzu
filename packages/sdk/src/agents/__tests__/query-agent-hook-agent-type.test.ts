import { describe, expect, it } from 'vitest'

import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import type { ManagedAgentInput, QueryAgentConfig } from '../../types/agent/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { PluginHookContext, PluginHookEvent } from '../../types/plugin/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { QueryAgent } from '../QueryAgent.js'

/**
 * What a child's lifecycle hooks are told its agent is. A host class marks
 * itself with `type`; a host that names its agents passes the name as
 * `config.agentType`, and that is what `subagent_start` and `subagent_stop`
 * carry.
 */
describe('the agent type a child agent’s hooks see', () => {
	const run = async (agentType?: string) => {
		const seen: { event: PluginHookEvent; agentType?: string }[] = []
		const manager = {
			executeHooks: async (event: PluginHookEvent, ctx: PluginHookContext) => {
				seen.push({ event, ...(ctx.agentType !== undefined ? { agentType: ctx.agentType } : {}) })
				return []
			},
		} as unknown as PluginLifecycleManager
		const sessionId = generateSessionId()
		const input: ManagedAgentInput = {
			messages: [createUserMessage('go')],
			workingDirectory: process.cwd(),
		}
		const config: QueryAgentConfig = {
			provider: new MockLLMProvider({ responseText: 'done' }),
			toolsets: [],
			model: 'mock-model',
			tokenBudget: 1_000,
			timeoutMs: 5_000,
			sessionId,
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			sessionLog: new InMemorySessionLog({ sessionId }),
			pluginManager: manager,
			parentSessionId: generateSessionId(),
			...(agentType !== undefined ? { agentType } : {}),
		}
		const agent = new QueryAgent({
			type: 'host-class',
			id: 'reviewer',
			name: 'reviewer',
			version: '1',
			category: 'test',
			description: 'a named agent',
		})
		await agent.run(input, config)
		return seen.filter(({ event }) => event === 'subagent_start' || event === 'subagent_stop')
	}

	it('is the name the host gave, on both events', async () => {
		expect(await run('reviewer')).toEqual([
			{ event: 'subagent_start', agentType: 'reviewer' },
			{ event: 'subagent_stop', agentType: 'reviewer' },
		])
	})

	it('is the agent’s type when the host names nothing, as it always was', async () => {
		expect(await run()).toEqual([
			{ event: 'subagent_start', agentType: 'host-class' },
			{ event: 'subagent_stop', agentType: 'host-class' },
		])
	})
})
