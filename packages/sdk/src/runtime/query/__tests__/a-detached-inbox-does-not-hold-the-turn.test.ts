import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { stubTaskScheduler } from '../../../__fixtures__/task-scheduler.js'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { TaskHandle } from '../../../types/agent/scheduler.js'
import type { SessionId, TaskId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A host that keeps background agents alive itself builds its inbox with
 * `holdsTurnOpen: false`. The turn then ends when the model has answered, with
 * the tasks still running, instead of parking at its settle point for them.
 *
 * Nothing here races a clock: a turn that wrongly held would wait out its
 * settle grace (about five seconds of the ten it is given) and trip Vitest's
 * own per-test timeout, so a hang is reported by the runner, not by a guard
 * written into the test.
 */

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

class AnswersOnce implements LLMProvider {
	readonly id = 'answers-once'
	readonly name = 'Answers Once'
	calls = 0
	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1
		yield { id: 'efe8f849-85cf-4b94-8bc7-cad64f257419', delta: { content: 'Launched.' } }
		yield {
			id: 'efe8f849-85cf-4b94-8bc7-cad64f257419',
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

async function run(inbox: CompletionInbox) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-detached-'))
	workdirs.push(workingDirectory)
	const provider = new AnswersOnce()
	const result = await drainQuery({
		provider,
		toolsets: [testToolset()],
		completionInbox: inbox,
		agentId: 'agent_test',
		agentName: 'Test Agent',
		messages: [createUserMessage('launch it')],
		workingDirectory,
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		sessionId: '1ed9f9be-fd1c-48e7-8838-25078c3a565c' as SessionId,
		topicId: 'cb989855-824c-46bc-89c2-abb0167af5e2' as TopicId,
		projectId: '27eb7b81-e899-4ea0-bb0e-03036b729ead' as ProjectId,
		tenantId: 'a11660b4-4fce-4579-9606-0794222c11c2' as TenantId,
	})
	return { result, provider }
}

describe('an inbox that does not hold the turn open', () => {
	it('ends the turn at the answer and leaves the task running and unreported', async () => {
		const inbox = new CompletionInbox(undefined, { holdsTurnOpen: false })
		inbox.attach(stubTaskScheduler({ onTaskCompleted: () => () => {}, getTask: () => undefined }))
		inbox.expect('tsk_background' as TaskId)

		const { result, provider } = await run(inbox)

		expect(provider.calls).toBe(1)
		expect(inbox.holdsTurn).toBe(false)
		// Handed over, not abandoned: the host owns the task from here on.
		expect(result.abandonedTaskIds).toBeUndefined()
		expect(inbox.outstandingTaskIds).toEqual(['tsk_background'])
	})

	it('still gives the model a completion that had already arrived', async () => {
		const inbox = new CompletionInbox(undefined, { holdsTurnOpen: false })
		inbox.launched('tsk_done' as TaskId)
		inbox.attach(
			stubTaskScheduler({
				onTaskCompleted: (cb: (h: TaskHandle) => void) => {
					cb({
						taskId: 'tsk_done' as TaskId,
						agentId: 'reviewer',
						state: 'completed',
						createdAt: 1_000,
						completedAt: 4_000,
						result: { status: 'completed', result: 'FINISHED EARLY' } as TaskHandle['result'],
					})
					return () => {}
				},
				getTask: () => undefined,
			}),
		)

		const { result } = await run(inbox)

		const users = result.messages
			.filter((m) => m.role === 'user')
			.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		expect(users.some((text) => text.includes('FINISHED EARLY'))).toBe(true)
	})

	it('keeps the original contract when the option is not given', () => {
		const inbox = new CompletionInbox()
		inbox.expect('tsk_running' as TaskId)
		expect(inbox.holdsTurnOpen).toBe(true)
		expect(inbox.holdsTurn).toBe(true)
	})
})
