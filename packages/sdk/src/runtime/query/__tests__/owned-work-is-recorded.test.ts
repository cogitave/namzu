import { expect, it } from 'vitest'
import { z } from 'zod'
import { stubTaskScheduler } from '../../../__fixtures__/task-scheduler.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { fixtureId } from '../../../test-support/ids.js'
import { historyOf } from '../../../test-support/request-only.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { TaskHandle } from '../../../types/agent/scheduler.js'
import { type Message, turnContextEntries } from '../../../types/message/index.js'
import { drainQuery } from '../index.js'

/**
 * A task that has finished is recorded once, in an entry of its own, and the
 * later requests read it from the conversation. The running list is true only
 * now, so it goes with each request and is never recorded.
 */

it('records each finished task once, when it finishes, and never the running list', async () => {
	const handles = new Map<string, TaskHandle>()
	const inbox = new CompletionInbox()
	inbox.attach(
		stubTaskScheduler({ getTask: (id) => handles.get(id), onTaskCompleted: () => () => {} }),
	)
	const finished = (name: string) => {
		const taskId = fixtureId.task(`owned-record-${name}`)
		handles.set(taskId, {
			taskId,
			agentId: 'worker',
			state: 'completed',
			createdAt: 1,
			result: { status: 'completed', stopReason: 'end_turn', result: name } as TaskHandle['result'],
		})
		inbox.launched(taskId)
		return taskId
	}
	const runningId = fixtureId.task('owned-record-running')
	inbox.launched(runningId)
	const ids: string[] = []
	const tools = testToolset(
		defineTool({
			name: 'delegate',
			description: 'Launch a worker that finishes at once',
			inputSchema: z.object({ name: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute({ name }) {
				ids.push(finished(name))
				return { success: true, output: `launched ${name}` }
			},
		}),
	)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'delegate', args: { name: 'one' } }] },
			{ toolCalls: [{ id: 'c2', name: 'delegate', args: { name: 'two' } }] },
			{ text: 'done' },
		],
	})
	const run = await drainQuery({
		provider,
		toolsets: [tools],
		completionInbox: inbox,
		agentId: 'parent',
		agentName: 'parent',
		tenantId: fixtureId.tenant('owned-record'),
		projectId: fixtureId.project('owned-record'),
		sessionId: fixtureId.session('owned-record'),
		topicId: fixtureId.topic('owned-record'),
		messages: [{ role: 'user', content: 'Delegate twice.' }],
		turnConfig: {
			model: 'mock',
			maxIterations: 5,
			maxResponseTokens: 100,
			tokenBudget: 10_000,
			timeoutMs: 10_000,
		},
		compactionConfig: CompactionConfigSchema.parse({
			strategy: 'disabled',
			contextWindowTokens: 100_000,
		}),
	})

	const entries = turnContextEntries(run.messages, 'owned-work')
	expect(entries).toHaveLength(2)
	expect(entries[0]).toContain(ids[0] as string)
	expect(entries[0]).not.toContain(ids[1] as string)
	expect(entries[1]).toContain(ids[1] as string)
	expect(entries[1]).not.toContain(ids[0] as string)
	// The task that never settled is named in the requests, and nowhere in the record.
	const sent = (index: number) =>
		(provider.requests[index]?.messages as Message[]).map((m) => String(m.content))
	const sentHistory = (index: number) =>
		historyOf(provider.requests[index]?.messages as Message[]).map((m) => String(m.content))
	expect(sent(2).some((text) => text.includes('still running') && text.includes(runningId))).toBe(
		true,
	)
	expect(run.messages.some((m) => String(m.content).includes('still running'))).toBe(false)
	// Every request begins with the whole history of the one before it.
	for (const i of [1, 2]) {
		const before = sentHistory(i - 1)
		expect(sentHistory(i).slice(0, before.length)).toEqual(before)
	}
	inbox.close()
})
