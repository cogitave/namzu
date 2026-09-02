import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import type { CreateMemoryParams, MemoryStore } from '../../../types/memory/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { query } from '../index.js'

/**
 * Episodic memory dies with the run. A host that passes `consolidateInto`
 * gets the run's decisions, discoveries and failures written to its store
 * as one learning, and an event saying so; a store that fails never fails
 * the run.
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
					id: 'mem_1' as never,
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
	const events: RunEvent[] = []
	for await (const event of query({
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
				{ text: 'The deploy key was rejected, so I stopped.' },
			],
		}),
		tools,
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('deploy the service')],
		workingDirectory,
		sessionId: 'ses_c' as SessionId,
		topicId: 'top_c' as TopicId,
		projectId: 'prj_c' as ProjectId,
		tenantId: 'tnt_c' as TenantId,
		resumeHandler: async () => ({ action: 'continue' }),
		compactionConfig: { strategy: 'salience' } as never,
		consolidateInto,
	})) {
		events.push(event)
	}
	return events
}

describe('a run writes down what it learned', () => {
	it('consolidates the failure into one tagged entry and says so', async () => {
		const memory = store()
		const events = await run(memory)
		expect(memory.created).toHaveLength(1)
		const entry = memory.created[0] as CreateMemoryParams
		expect(entry.tags).toContain('learning')
		expect(entry.content).toContain('deploy: ')
		expect(entry.content).toContain('deploy key was rejected')
		const consolidated = events.find((e) => e.type === 'memory_consolidated')
		expect(consolidated).toMatchObject({ memoryId: 'mem_1', failures: 1 })
		const order = events.map((e) => e.type)
		expect(order.indexOf('memory_consolidated')).toBeLessThan(order.indexOf('run_completed'))
	})

	it('never fails the run when the store does', async () => {
		const events = await run(store(true))
		expect(events.some((e) => e.type === 'run_completed')).toBe(true)
		expect(events.some((e) => e.type === 'memory_consolidated')).toBe(false)
	})
})
