import { describe, expect, it, vi } from 'vitest'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { createMemoryRecallStep } from '../../../run/memory-recall.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { buildMemoryTools } from '../../../tools/memory/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

registerMock()

describe('memory controls the next actual model request', () => {
	it('recalls, corrects and archives without retaining stale recalled text in history', async () => {
		const store = new InMemoryMemoryStore()
		const { entry } = await store.create({
			title: 'cerulean cache',
			summary: 'Expiry',
			content: 'cerulean-cache expires after 14 hours',
		})
		const tools = new ToolRegistry()
		tools.register(buildMemoryTools(store))
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							name: 'update_memory',
							args: {
								id: entry.id,
								content: 'cerulean-cache expires after 28 hours',
							},
						},
					],
				},
				{
					toolCalls: [
						{
							name: 'update_memory',
							args: { id: entry.id, status: 'archived' },
						},
					],
				},
				{ text: 'The obsolete memory is archived.' },
			],
		})
		const requests: string[] = []
		const original = provider.chatStream.bind(provider)
		vi.spyOn(provider, 'chatStream').mockImplementation((params) => {
			requests.push(
				params.messages
					.filter((m) => m.role === 'system')
					.map((m) => m.content)
					.join('\n'),
			)
			return original(params)
		})
		const run = await drainQuery({
			provider,
			tools,
			prepareStep: createMemoryRecallStep({ store }),
			agentId: 'memory-lifecycle',
			agentName: 'Memory lifecycle',
			messages: [
				{
					role: 'user',
					content: 'Correct cerulean-cache expiry to 28 hours, then archive the record.',
				},
			],
			workingDirectory: process.cwd(),
			runConfig: {
				model: 'mock',
				timeoutMs: 10000,
				tokenBudget: 100000,
				maxIterations: 5,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
		})
		expect(run.status).toBe('completed')
		expect(requests).toHaveLength(3)
		expect(requests[0]).toContain('14 hours')
		expect(requests[1]).toContain('28 hours')
		expect(requests[1]).not.toContain('14 hours')
		expect(requests[2]).not.toContain('Retrieved project memory')
		expect(JSON.stringify(run.messages)).not.toContain('Retrieved project memory')
		expect((await store.list({ status: 'archived' })).entries[0]?.id).toBe(entry.id)
	})
})
