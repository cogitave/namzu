import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompletionInbox } from '../../../gateway/completion-inbox.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { TaskHandle } from '../../../types/agent/gateway.js'
import type { SessionId, TaskId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The last link, and the one most likely to be built and never wired.
 *
 * `CompletionInbox` can queue an unclaimed completion and format it, and the
 * coordinator tools can decline to claim one — but none of that reaches the
 * model unless the iteration loop actually drains the inbox into the
 * transcript. A mechanism that is declared, threaded through types, and
 * driven by nothing is precisely the shape of the defect this whole change
 * exists to fix, so the drain gets its own test at the loop level rather
 * than being assumed from its parts.
 */

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Calls a tool once, then answers. Two turns is all the drain needs. */
class ToolThenAnswerProvider implements LLMProvider {
	readonly id = 'tool-then-answer'
	readonly name = 'Tool Then Answer Provider'
	calls = 0

	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1

		if (this.calls === 1) {
			yield {
				id: 'msg_1',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_noop_1',
							type: 'function',
							function: { name: 'noop', arguments: '{}' },
						},
					],
				},
			}
			yield {
				id: 'msg_1',
				delta: {},
				finishReason: 'tool_calls',
				usage: ZERO_USAGE,
			}
			return
		}

		yield { id: 'msg_2', delta: { content: 'Done.' } }
		yield { id: 'msg_2', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

const noop = defineTool({
	name: 'noop',
	description: 'does nothing',
	inputSchema: z.object({}),
	category: 'analysis',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	async execute() {
		return { success: true, output: 'ok' }
	},
})

function completed(taskId: string, result: string): TaskHandle {
	return {
		taskId: taskId as TaskId,
		agentId: 'reviewer',
		state: 'completed',
		createdAt: 1_000,
		completedAt: 4_000,
		result: { status: 'completed', result } as TaskHandle['result'],
	}
}

const workdirs: string[] = []
afterEach(async () => {
	await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
	workdirs.length = 0
})

async function runWith(inbox: CompletionInbox | undefined): Promise<string[]> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-completion-'))
	workdirs.push(workingDirectory)

	const tools = new ToolRegistry()
	tools.register(noop)

	const run = await drainQuery({
		provider: new ToolThenAnswerProvider(),
		tools,
		...(inbox ? { completionInbox: inbox } : {}),
		agentId: 'agent_test',
		agentName: 'Test Agent',
		messages: [createUserMessage('delegate and report')],
		workingDirectory,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		sessionId: 'ses_completion' as SessionId,
		threadId: 'thd_completion' as ThreadId,
		projectId: 'prj_completion' as ProjectId,
		tenantId: 'tnt_completion' as TenantId,
	})

	return run.messages
		.filter((m) => m.role === 'user')
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}

describe('an unclaimed completion reaches the transcript', () => {
	it('injects the notification as a user message the next turn can read', async () => {
		const inbox = new CompletionInbox()
		// Settled by a gateway before the turn ended, with nothing waiting on
		// it — the abandoned-launch case.
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				cb(completed('tsk_late', 'the worker finished after the wait was abandoned'))
				return () => {}
			},
		} as never)

		const userMessages = await runWith(inbox)
		const notification = userMessages.find((m) => m.includes('task-notification'))

		expect(notification).toBeDefined()
		expect(notification).toContain('tsk_late')
		expect(notification).toContain('the worker finished after the wait was abandoned')
	})

	it('drains it exactly once, however many turns follow', async () => {
		const inbox = new CompletionInbox()
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				cb(completed('tsk_late', 'only once'))
				return () => {}
			},
		} as never)

		const userMessages = await runWith(inbox)

		expect(userMessages.filter((m) => m.includes('task-notification'))).toHaveLength(1)
	})

	it('says nothing when every completion was already delivered', async () => {
		// The `dc16d58` regression at the loop level: a blocking `create_task`
		// claims its own completion, so the transcript must stay clean.
		const inbox = new CompletionInbox()
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				cb(completed('tsk_awaited', 'delivered as a tool_result'))
				return () => {}
			},
		} as never)
		inbox.claim('tsk_awaited' as TaskId)

		const userMessages = await runWith(inbox)

		expect(userMessages.some((m) => m.includes('task-notification'))).toBe(false)
	})

	it('runs unchanged with no inbox at all', async () => {
		// The kernel must not require one: a host on the old wiring keeps
		// working, it just never hears about abandoned completions.
		const userMessages = await runWith(undefined)

		expect(userMessages.some((m) => m.includes('task-notification'))).toBe(false)
	})
})
