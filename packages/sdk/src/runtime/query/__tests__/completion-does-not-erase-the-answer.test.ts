import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

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
 * A notification appended after the answer must not become the answer's grave.
 *
 * `RunPersistence.resolveResult` assembles `Run.result` by walking the message
 * tail BACKWARDS and stopping at the first non-assistant message, and it runs
 * at `markCompleted` — after the loop has finished. So a task notification
 * pushed after the final assistant turn hides that turn from the assembler
 * entirely.
 *
 * This is not hypothetical. It was introduced by the change that made every
 * exit hand over a finished worker's output, and measured here: a run whose
 * model had just said "THIS IS THE RUN ANSWER." returned `run.result ===
 * undefined`. Trading a lost worker result for a lost RUN result is strictly
 * worse than the defect the delivery exists to fix, and every one of the
 * suite's 2,600 tests passed while it was true, because none of them asserted
 * `run.result` on a path where a completion could land last.
 */

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const ANSWER = 'THIS IS THE RUN ANSWER.'

function completed(): TaskHandle {
	return {
		taskId: 'tsk_bg' as TaskId,
		agentId: 'reviewer',
		state: 'completed',
		createdAt: 0,
		completedAt: 1,
		result: { status: 'completed', result: 'THE WORKER RESULT' },
	} as TaskHandle
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

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

describe('a completion delivered on the way out leaves the answer readable', () => {
	it('keeps run.result when the worker lands during the closing turn', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-answer-'))
		workdirs.push(workingDirectory)

		const inbox = new CompletionInbox()
		let announce: ((h: TaskHandle) => void) | undefined
		inbox.launched('tsk_bg' as TaskId)
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				announce = cb
				return () => {
					announce = undefined
				}
			},
			getTask: () => undefined,
		} as never)

		/**
		 * One tool call, then the iteration ceiling forces a closing turn. The
		 * worker settles DURING that closing turn — after the last in-loop
		 * drain, so the only thing left to deliver it is the exit path.
		 */
		class ClosingTurnProvider implements LLMProvider {
			readonly id = 'closing-turn'
			readonly name = 'Closing Turn Provider'
			calls = 0
			async *chatStream(): AsyncIterable<StreamChunk> {
				this.calls += 1
				if (this.calls === 1) {
					yield {
						id: 'm1',
						delta: {
							toolCalls: [
								{
									index: 0,
									id: 'toolu_1',
									type: 'function',
									function: { name: 'noop', arguments: '{}' },
								},
							],
						},
					}
					yield { id: 'm1', delta: {}, finishReason: 'tool_calls', usage: ZERO_USAGE }
					return
				}
				announce?.(completed())
				yield { id: 'm2', delta: { content: ANSWER } }
				yield { id: 'm2', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
			}
		}

		const tools = new ToolRegistry()
		tools.register(noop)

		const run = await drainQuery({
			provider: new ClosingTurnProvider(),
			tools,
			completionInbox: inbox,
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('go')],
			workingDirectory,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			sessionId: 'ses_answer' as SessionId,
			threadId: 'thd_answer' as ThreadId,
			projectId: 'prj_answer' as ProjectId,
			tenantId: 'tnt_answer' as TenantId,
		} as never)

		// Both halves, because either one alone is satisfied by a broken fix:
		// dropping the delivery keeps the answer, and dropping the answer fix
		// keeps the notification.
		expect(run.result, 'the notification buried the run answer').toBe(ANSWER)
		expect(
			(run.messages as { content: unknown }[]).some(
				(m) => typeof m.content === 'string' && m.content.includes('THE WORKER RESULT'),
			),
			'the worker result was not delivered',
		).toBe(true)
	}, 60_000)
})
