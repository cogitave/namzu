import { describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { buildMemoryTools } from '../../../tools/memory/index.js'
import type { Message } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

describe.each(['text', 'json'] as const)('%s memory read on the model wire', (format) => {
	it('includes the revision in the next model request while preserving the tool output', async () => {
		const store = new InMemoryMemoryStore()
		const body = format === 'json' ? '{"expiry":14}' : 'Cache expires in 14 hours.'
		const { entry } = await store.create({
			title: 'Cache expiry',
			summary: 'Expiry',
			content: body,
			format,
		})
		const revision = (await store.getVersionedRecord(entry.id))?.revision
		expect(revision).toMatch(/^m2:[a-f0-9]{64}$/)
		const requests: Message[][] = []
		const run = await drainQuery({
			provider: new MockLLMProvider({
				onRequest: ({ messages }) => requests.push([...messages]),
				turns: [
					{ toolCalls: [{ id: 'read_1', name: 'read_memory', args: { id: entry.id } }] },
					{ text: 'Done.' },
				],
			}),
			toolsets: [testToolset(...buildMemoryTools(store))],
			agentId: 'memory-revision-wire',
			agentName: 'Memory revision wire',
			messages: [{ role: 'user', content: 'Read the cache memory.' }],
			workingDirectory: process.cwd(),
			turnConfig: { model: 'mock', timeoutMs: 10000, tokenBudget: 100000, maxIterations: 3 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
		})
		expect(run.status).toBe('completed')
		expect(requests).toHaveLength(2)
		const receipt = requests[1]?.find((message) => message.role === 'tool')
		expect(receipt?.content).toEqual([
			{ type: 'text', text: expect.stringContaining(body) },
			{
				type: 'text',
				text: expect.stringContaining(`Memory revision: ${revision}`),
			},
		])
		if (format === 'json') {
			const blocks = receipt?.content
			if (!Array.isArray(blocks) || blocks[0]?.type !== 'text') {
				throw new Error('Expected a JSON text block')
			}
			expect(blocks[0].text).toBe(body)
			expect(JSON.parse(blocks[0].text)).toEqual({ expiry: 14 })
		}
	})
})
