import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { buildCoordinatorTools } from '../../../tools/coordinator/index.js'
import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import {
	generateProjectId,
	generateSessionId,
	generateTaskId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
const workdirs: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

async function fixture(options: { terminal?: boolean; fakeClock?: boolean } = {}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-tracking-gate-'))
	workdirs.push(workingDirectory)
	if (options.fakeClock) vi.useFakeTimers()
	const sessionId = generateSessionId()
	const store = new InMemoryTaskStore()
	const persistence = deferred()
	const entered = deferred()
	const draining = deferred()
	const update = store.update.bind(store)
	vi.spyOn(store, 'update').mockImplementation(async (id, input) => {
		if (input.status === 'completed') {
			entered.resolve()
			await persistence.promise
		}
		return update(id, input)
	})
	const handle: TaskHandle = {
		taskId: generateTaskId(),
		agentId: 'worker',
		state: 'completed',
		createdAt: 1,
		completedAt: 2,
		result: { status: 'completed', result: 'THE SETTLED WORKER RESULT' } as TaskHandle['result'],
	}
	const gateway: TaskScheduler = {
		createTask: async () => handle,
		waitForTask: async () => handle,
		continueTask: async () => {},
		cancelTask: () => {},
		getTask: () => handle,
		listTasks: () => [handle],
		onTaskCompleted: () => () => {},
	}
	const inbox = new CompletionInbox()
	inbox.attach(gateway)
	const drain = inbox.drainAsync.bind(inbox)
	vi.spyOn(inbox, 'drainAsync').mockImplementation((signal) => {
		const pending = drain(signal)
		draining.resolve()
		return pending
	})
	const create = buildCoordinatorTools({
		gateway,
		completionInbox: inbox,
		taskStore: store,
		sessionId,
		turnId: generateTurnId(),
		workingDirectory,
		allowedAgentIds: ['worker'],
	}).find((tool) => tool.name === 'create_task')
	if (!create) throw new Error('Missing create_task')
	const caller = new AbortController()
	const zeroUsage = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	let calls = 0
	const provider: LLMProvider = {
		id: 'tracking-gate',
		name: 'Tracking Gate',
		async *chatStream(): AsyncIterable<StreamChunk> {
			calls++
			if (calls === 1) {
				yield {
					id: 'first',
					delta: {
						toolCalls: [
							{
								index: 0,
								id: 'launch',
								type: 'function',
								function: {
									name: 'create_task',
									arguments: JSON.stringify({
										agent_id: 'worker',
										prompt: 'Review',
										description: 'Review',
										background: true,
									}),
								},
							},
						],
					},
				}
				yield { id: 'first', delta: {}, finishReason: 'tool_calls', usage: zeroUsage }
			} else {
				yield { id: 'answer', delta: { content: 'The turn can stop.' } }
				yield { id: 'answer', delta: {}, finishReason: 'stop', usage: zeroUsage }
			}
		},
	}
	const run = drainQuery({
		provider,
		toolsets: [testToolset({ ...create, ...(options.terminal ? { terminal: true } : {}) })],
		completionInbox: inbox,
		taskStore: store,
		signal: caller.signal,
		agentId: 'parent',
		agentName: 'Parent',
		messages: [createUserMessage('Delegate work')],
		workingDirectory,
		sessionId,
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
	})
	return { run, store, caller, inbox, persistence, entered, draining, handle }
}

describe('pending planning persistence cannot strand a stopped query', () => {
	it('settles caller cancellation while actual TaskStore.update is still blocked', async () => {
		const f = await fixture()
		try {
			await f.entered.promise
			await f.draining.promise
			f.caller.abort(new TurnCancelled('user'))
			const run = await f.run
			expect(run.status).toBe('cancelled')
			expect(run.stopReason).toBe('cancelled')
			expect((await f.store.list())[0]?.status).toBe('in_progress')
			expect(f.inbox.hasPendingWork).toBe(true)
			expect(JSON.stringify(run.messages)).not.toContain('THE SETTLED WORKER RESULT')
		} finally {
			f.persistence.resolve()
			await f.inbox.drainAsync()
			f.inbox.close()
		}
		expect((await f.store.list())[0]?.status).toBe('completed')
	})

	it('respects the existing turn deadline without cancelling or claiming the tracking write', async () => {
		const f = await fixture({ fakeClock: true })
		try {
			await f.entered.promise
			await f.draining.promise
			await vi.advanceTimersByTimeAsync(20_000)
			const run = await f.run
			expect(run.stopReason).toBe('timeout')
			expect((await f.store.list())[0]?.status).toBe('in_progress')
			expect(f.inbox.hasPendingWork).toBe(true)
		} finally {
			f.persistence.resolve()
			await f.inbox.drainAsync()
			f.inbox.close()
		}
		expect((await f.store.list())[0]?.status).toBe('completed')
	})

	it('does not wait on persistence from the terminal-tool finalizer', async () => {
		const f = await fixture({ terminal: true })
		try {
			await f.entered.promise
			const run = await f.run
			expect(run.status).toBe('completed')
			expect((await f.store.list())[0]?.status).toBe('in_progress')
			expect(f.inbox.hasPendingWork).toBe(true)
			f.persistence.resolve()
			expect((await f.inbox.drainAsync()).map((handle) => handle.taskId)).toEqual([f.handle.taskId])
			expect((await f.store.list())[0]?.status).toBe('completed')
		} finally {
			f.persistence.resolve()
			f.inbox.close()
		}
	})
})
