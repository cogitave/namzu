import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Message } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A tool that continues the caller's conversation (a delegate that inherits it)
 * reads it through the context, live: the messages as the model sees them,
 * ending with the assistant message that issued the call, and the system prompt
 * the model was given.
 */
describe('a tool reads the conversation it belongs to', () => {
	it('sees the messages up to its own call and the assembled system prompt', async () => {
		let seen: { messages: readonly Message[]; prompt: string | undefined } | undefined
		const probe = defineTool({
			name: 'probe',
			description: 'reads the conversation',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (_input, context) => {
				seen = {
					messages: [...(context.conversation?.messages() ?? [])],
					prompt: context.conversation?.systemPrompt(),
				}
				return { success: true, output: 'ok' }
			},
		})
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'probe', args: {} }] }, { text: 'done' }],
		})
		await drainQuery({
			provider,
			toolsets: [testToolset(probe)],
			agentId: 'conversation-fixture',
			agentName: 'Conversation fixture',
			systemPrompt: 'Be brief.',
			messages: [{ role: 'user', content: 'look around' }],
			workingDirectory: process.cwd(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
			turnConfig: { model: 'mock', maxIterations: 4, tokenBudget: 200_000, timeoutMs: 20_000 },
		})
		expect(seen?.prompt).toContain('Be brief.')
		const roles = seen?.messages.filter((m) => m.role !== 'system').map((m) => m.role)
		expect(roles).toEqual(['user', 'assistant'])
		const last = seen?.messages.at(-1)
		expect(last?.role === 'assistant' && last.toolCalls?.[0]?.id).toBe('c1')
	})
})
