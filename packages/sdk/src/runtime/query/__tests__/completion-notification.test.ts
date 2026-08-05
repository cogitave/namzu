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
import type { Message } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
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
	/**
	 * What the model was actually SHOWN, turn by turn.
	 *
	 * `run.messages` proves a notification exists somewhere in the transcript.
	 * It does not prove the model ever saw it — a delivery that only happens on
	 * the way out satisfies the transcript and leaves the model with nothing to
	 * act on, which is the whole point of injecting mid-run.
	 */
	readonly requests: Message[][] = []

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls += 1
		this.requests.push([...params.messages])

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

/** The same two turns, aimed at the tool the exit tests register. */
class CallsFinisherProvider implements LLMProvider {
	readonly id = 'calls-finisher'
	readonly name = 'Calls Finisher Provider'
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
							id: 'toolu_finisher_1',
							type: 'function',
							function: { name: 'finisher', arguments: '{}' },
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

async function runWith(
	inbox: CompletionInbox | undefined,
): Promise<{ userMessages: string[]; provider: ToolThenAnswerProvider }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-completion-'))
	workdirs.push(workingDirectory)

	const tools = new ToolRegistry()
	tools.register(noop)

	const provider = new ToolThenAnswerProvider()
	const run = await drainQuery({
		provider,
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

	return {
		userMessages: run.messages
			.filter((m) => m.role === 'user')
			.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
		provider,
	}
}

/** Settled before the turn ended, with nothing waiting on it. */
function inboxHolding(taskId: string, result: string): CompletionInbox {
	const inbox = new CompletionInbox()
	// Said before the announcement because `create_task` says it on every
	// launch: an inbox only hears about tasks its own run started, so a
	// gateway shared between two supervisors cannot cross-deliver.
	inbox.launched(taskId as TaskId)
	inbox.attach({
		onTaskCompleted: (cb: (h: TaskHandle) => void) => {
			cb(completed(taskId, result))
			return () => {}
		},
		getTask: () => undefined,
	} as never)
	return inbox
}

describe('an unclaimed completion reaches the transcript', () => {
	it('injects the notification as a user message the next turn can read', async () => {
		const inbox = inboxHolding('tsk_late', 'the worker finished after the wait was abandoned')

		const { userMessages } = await runWith(inbox)
		const notification = userMessages.find((m) => m.includes('task-notification'))

		expect(notification).toBeDefined()
		expect(notification).toContain('tsk_late')
		expect(notification).toContain('the worker finished after the wait was abandoned')
	})

	it('shows it to the model on the very next turn, not eventually', async () => {
		// Three sites now drain this inbox — the post-tool-batch injection, the
		// bounded hold on the final-answer turn, and the exit-time delivery —
		// and all three put the same text in `run.messages`. So an assertion on
		// the transcript, or on the LAST model request, passes whichever of the
		// three did the work, and none of them is pinned.
		//
		// The one that matters is the injection right after the tool batch,
		// because it is the only one that reaches the model while there is
		// still work to redirect. Hence the SECOND request specifically: with
		// that injection gone the notification still arrives, one turn later,
		// via the hold — later is a different behaviour, and this is the
		// assertion that can tell them apart.
		const inbox = inboxHolding('tsk_late', 'THE WORKER SAID THIS')

		const { provider } = await runWith(inbox)

		const turnAfterTheToolBatch = provider.requests[1] ?? []
		expect(
			turnAfterTheToolBatch.some(
				(m) => typeof m.content === 'string' && m.content.includes('THE WORKER SAID THIS'),
			),
			'the model was not shown the completion on the turn after the tool batch',
		).toBe(true)
	})

	it('drains it exactly once, however many turns follow', async () => {
		const inbox = inboxHolding('tsk_late', 'only once')

		const { userMessages } = await runWith(inbox)

		expect(userMessages.filter((m) => m.includes('task-notification'))).toHaveLength(1)
	})

	it('says nothing when every completion was already delivered', async () => {
		// The `dc16d58` regression at the loop level: a blocking `create_task`
		// claims its own completion, so the transcript must stay clean.
		const inbox = inboxHolding('tsk_awaited', 'delivered as a tool_result')
		inbox.claim('tsk_awaited' as TaskId)

		const { userMessages } = await runWith(inbox)

		expect(userMessages.some((m) => m.includes('task-notification'))).toBe(false)
	})

	it('runs unchanged with no inbox at all', async () => {
		// The kernel must not require one: a host on the old wiring keeps
		// working, it just never hears about abandoned completions.
		const { userMessages } = await runWith(undefined)

		expect(userMessages.some((m) => m.includes('task-notification'))).toBe(false)
	})
})

/**
 * The exits that are not the ordinary final answer.
 *
 * The inbox was consulted at exactly one site, inside the no-tool-calls branch.
 * The loop leaves by eight other routes, and three of them are ways a run
 * legitimately ENDS: a tool the author declared terminal, a captured structured
 * output, and the host's `stopWhen`. A worker that finished while any of those
 * was deciding had its output dropped on the floor — the gateway held the
 * result, the run closed, and nothing ever read it.
 *
 * These drive `drainQuery` rather than the helper directly, and that is the
 * point: the delivery happens in the loop, so a unit test on the inbox proves
 * nothing about whether the loop reaches it.
 */
describe('a run that ends some other way still hands over what finished', () => {
	async function runEndingWith(options: {
		terminal?: boolean
		stopWhen?: boolean
	}): Promise<string[]> {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-completion-exit-'))
		workdirs.push(workingDirectory)

		const inbox = new CompletionInbox()
		inbox.launched('tsk_bg' as TaskId)
		let announce: ((h: TaskHandle) => void) | undefined
		inbox.attach({
			onTaskCompleted: (cb: (h: TaskHandle) => void) => {
				announce = cb
				return () => {
					announce = undefined
				}
			},
			getTask: () => undefined,
		} as never)

		// Settles from inside the tool call, so the completion is in hand
		// BEFORE the exit is decided. The question under test is which exits
		// hand it over, not whether the wait works.
		const finisher = defineTool({
			name: 'finisher',
			description: 'the worker finishes while this runs',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			...(options.terminal ? { terminal: true } : {}),
			async execute() {
				announce?.(completed('tsk_bg', 'THE BACKGROUND WORKER RESULT'))
				return { success: true, output: 'this call is the answer' }
			},
		})

		const tools = new ToolRegistry()
		tools.register(finisher)

		const run = await drainQuery({
			provider: new CallsFinisherProvider(),
			tools,
			completionInbox: inbox,
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('delegate and report')],
			workingDirectory,
			...(options.stopWhen ? { stopWhen: () => true } : {}),
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

	it('a terminal tool settles the run without discarding the worker', async () => {
		const userMessages = await runEndingWith({ terminal: true })

		expect(
			userMessages.some((m) => m.includes('THE BACKGROUND WORKER RESULT')),
			'the terminal-tool exit dropped a finished completion',
		).toBe(true)
	})

	it("the host's stopWhen ends the run without discarding it either", async () => {
		const userMessages = await runEndingWith({ stopWhen: true })

		expect(
			userMessages.some((m) => m.includes('THE BACKGROUND WORKER RESULT')),
			'the stopWhen exit dropped a finished completion',
		).toBe(true)
	})

	it('hands it over exactly once when the ordinary exit already did', async () => {
		// The `dc16d58` failure in a new place: an exit-time delivery that
		// re-sends what the in-loop drain already sent is the duplicate bug
		// again. `drain()` empties, so the second call finds nothing.
		const userMessages = await runEndingWith({})

		expect(userMessages.filter((m) => m.includes('THE BACKGROUND WORKER RESULT'))).toHaveLength(1)
	})
})
