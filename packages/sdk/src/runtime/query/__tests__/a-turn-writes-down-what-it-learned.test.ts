import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import type { CreateMemoryParams, MemoryStore } from '../../../types/memory/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { query } from '../index.js'

/**
 * Episodic memory dies with the turn. A host that passes `consolidateInto`
 * gets the turn's decisions, discoveries and failures written to its store
 * as one learning, and an event saying so; a store that fails never fails
 * the turn.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function store(fail = false): MemoryStore & { created: CreateMemoryParams[] } {
	const created: CreateMemoryParams[] = []
	return {
		created,
		async create(params) {
			if (fail) throw new Error('disk full')
			created.push(params)
			return {
				entry: {
					id: '22132404-d6ef-407b-9604-29c0ba7289c5' as never,
					title: params.title,
					summary: params.summary,
					tags: params.tags ?? [],
					status: 'active' as never,
					createdAt: 1,
					updatedAt: 1,
				} as never,
				content: { ...params } as never,
			}
		},
		async get() {
			return undefined
		},
		async update() {
			return undefined
		},
		async delete() {
			return false
		},
		async list() {
			return { entries: [], total: 0 } as never
		},
	}
}

async function run(consolidateInto: MemoryStore) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-consolidate-'))
	dirs.push(workingDirectory)
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'deploy',
			description: 'fails once',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: false, output: '', error: 'the deploy key was rejected' }),
		}),
	)
	const events: SessionEvent[] = []
	for await (const event of query({
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
				{ text: 'The deploy key was rejected, so I stopped.' },
			],
		}),
		tools,
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('deploy the service')],
		workingDirectory,
		sessionId: 'fd031048-1d65-449b-b6f2-0a8f2ba6b99f' as SessionId,
		topicId: '7f2cf483-e642-4898-8ac3-316074ab3639' as TopicId,
		projectId: '8d8cdcf3-4c2c-484c-b208-54dcd1964be4' as ProjectId,
		tenantId: 'bdb9c2e1-6b7c-4ac5-8cbb-671454d33d89' as TenantId,
		resumeHandler: async () => ({ action: 'continue' }),
		compactionConfig: { strategy: 'salience' } as never,
		consolidateInto,
	})) {
		events.push(event)
	}
	return events
}

describe('a turn writes down what it learned', () => {
	it('consolidates the failure into one tagged entry and says so', async () => {
		const memory = store()
		const events = await run(memory)
		expect(memory.created).toHaveLength(1)
		const entry = memory.created[0] as CreateMemoryParams
		expect(entry.tags).toContain('learning')
		expect(entry.content).toContain('deploy: ')
		expect(entry.content).toContain('deploy key was rejected')
		const consolidated = events.find((e) => e.type === 'memory_consolidated')
		expect(consolidated).toMatchObject({
			memoryId: '22132404-d6ef-407b-9604-29c0ba7289c5',
			failures: 1,
		})
		const order = events.map((e) => e.type)
		expect(order.indexOf('memory_consolidated')).toBeLessThan(order.indexOf('turn_completed'))
	})

	it('writes the same knowledge once, even after it was archived', async () => {
		const memory = new InMemoryMemoryStore()
		const first = await run(memory)
		expect(first.some((e) => e.type === 'memory_consolidated')).toBe(true)
		const [saved] = (await memory.list()).entries
		expect(saved?.type).toBe('project')
		expect(saved?.tags.some((tag) => tag.startsWith('knowledge:'))).toBe(true)

		const second = await run(memory)
		expect(second.some((e) => e.type === 'memory_consolidated')).toBe(false)
		expect(second.some((e) => e.type === 'turn_completed')).toBe(true)
		expect((await memory.list()).totalCount).toBe(1)

		await memory.update(saved?.id as never, { status: 'archived' })
		await run(memory)
		expect((await memory.list()).totalCount).toBe(1)
	})

	it('never fails the turn when the store does', async () => {
		const events = await run(store(true))
		expect(events.some((e) => e.type === 'turn_completed')).toBe(true)
		expect(events.some((e) => e.type === 'memory_consolidated')).toBe(false)
	})
})
