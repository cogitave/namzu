import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createMemoryRecallStep } from '../../../turn/memory-recall.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

/**
 * Recall with `record` reports which stored memories went into the turn, once,
 * when the entry is recorded, and says who wrote each one.
 */

registerMock()

describe('recalled memory is reported', () => {
	it('emits memory_recalled once with each memory, its writer and nothing for a repeat step', async () => {
		const store = new InMemoryMemoryStore()
		await store.create({
			title: 'Cache finding',
			name: 'cache-finding',
			summary: 'One discovery',
			content: 'cerulean-cache expires after 14 hours',
		})
		await store.create({
			title: 'A turn account',
			summary: 'cerulean-cache again',
			content: 'cerulean-cache was discussed',
			metadata: { source: 'session-memory' },
		})
		const tools = testToolset({
			name: 'look',
			description: 'Look at something',
			inputSchema: z.object({ what: z.string() }),
			execute: async () => ({ success: true, output: 'seen' }),
		})
		const events: SessionEvent[] = []
		await drainQuery(
			{
				toolsets: [tools],
				agentId: 'a',
				agentName: 'A',
				systemPrompt: 'You are a coding agent.',
				workingDirectory: process.cwd(),
				turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
				compactionConfig: CompactionConfigSchema.parse({}),
				tenantId: fixtureId.tenant('mem-rec'),
				projectId: fixtureId.project('mem-rec'),
				sessionId: fixtureId.session('mem-rec'),
				topicId: fixtureId.topic('mem-rec'),
				provider: new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
						{ text: 'done' },
					],
				}),
				prepareStep: createMemoryRecallStep({ store, record: true }),
				messages: [{ role: 'user', content: 'what did we learn about cerulean-cache expiry' }],
				retry: false,
			},
			(event) => {
				events.push(event)
			},
		)
		const recalled = events.filter((e) => e.type === 'memory_recalled')
		expect(recalled).toHaveLength(1)
		const memories = recalled[0]?.type === 'memory_recalled' ? recalled[0].memories : []
		expect(memories.map((m) => [m.title, m.origin]).sort()).toEqual([
			['A turn account', 'derived'],
			['Cache finding', 'operator'],
		])
		expect(memories.find((m) => m.title === 'Cache finding')?.name).toBe('cache-finding')
	})
})
