import {
	CompletionInbox,
	ToolRegistry,
	asProjectId,
	asSessionId,
	asTenantId,
	asTopicId,
	buildCoordinatorTools,
	drainQuery,
	runAgent,
} from '@namzu/sdk'
import type { TaskGateway, TaskHandle } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * Does a real model actually receive a worker it stopped waiting for?
 *
 * Everything else about this mechanism is tested against fakes: the inbox
 * queues what nobody claimed, the tools claim what they deliver, the loop
 * drains the rest into the transcript. All of it can be true and the feature
 * still useless, because the part that decides whether it works is whether a
 * MODEL reads the notification and acts on it — and no fake can answer that.
 *
 * So this runs the whole thing against the live API: a real supervisor model,
 * a real worker model, a background launch, and an assertion that the answer
 * the supervisor finally gives contains something only the worker knew.
 *
 * The gateway here is deliberately hand-rolled over `runAgent` rather than
 * the kernel's `LocalTaskGateway`. That is the shape a host implements, so it
 * doubles as proof that the inbox needs nothing from a gateway beyond the
 * `onTaskCompleted` every gateway already has.
 *
 * Skipped without a key. Run with:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @namzu/anthropic test
 */

const KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.NAMZU_WIRE_TEST_MODEL ?? 'claude-haiku-4-5'

/** The fact only the worker can know, so its presence proves delivery. */
const SECRET = 'PELICAN-7731'

function provider(): AnthropicProvider {
	return new AnthropicProvider({ apiKey: KEY as string, model: MODEL })
}

/**
 * A host-shaped gateway: spawns a real child run per task and announces it.
 *
 * Nothing here is kernel code. It implements `TaskGateway` the way an
 * embedding application does, which is the point — the inbox attaches to it
 * unchanged.
 */
function liveGateway(): TaskGateway {
	const handles = new Map<string, TaskHandle>()
	const settled = new Map<string, Promise<TaskHandle>>()
	const listeners = new Set<(h: TaskHandle) => void>()
	let seq = 0

	return {
		async createTask({ agentId, prompt }) {
			seq += 1
			const taskId = `tsk_live_${seq}`
			const handle: TaskHandle = {
				taskId: taskId as TaskHandle['taskId'],
				agentId,
				state: 'running',
				createdAt: Date.now(),
			}
			handles.set(taskId, handle)

			settled.set(
				taskId,
				runAgent({
					provider: provider(),
					model: MODEL,
					prompt,
					instructions: 'Answer in one short sentence. Do not explain yourself.',
					maxIterations: 2,
					tokenBudget: 20_000,
				}).then((run) => {
					const done: TaskHandle = {
						...handle,
						state: 'completed',
						completedAt: Date.now(),
						result: {
							status: 'completed',
							result: run.output ?? '',
						} as TaskHandle['result'],
					}
					handles.set(taskId, done)
					for (const cb of listeners) cb(done)
					return done
				}),
			)

			return handle
		},
		waitForTask: async (taskId) => {
			const pending = settled.get(taskId)
			if (!pending) throw new Error(`no task ${taskId}`)
			return pending
		},
		continueTask: async () => undefined,
		cancelTask: () => undefined,
		getTask: (taskId) => handles.get(taskId),
		listTasks: () => [...handles.values()],
		onTaskCompleted: (cb) => {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
	} as TaskGateway
}

describe.skipIf(!KEY)('a background worker reaches a real supervisor', () => {
	it('delivers the result through the transcript, with no polling', async () => {
		const gateway = liveGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		const tools = new ToolRegistry()
		for (const tool of buildCoordinatorTools({
			gateway,
			completionInbox: inbox,
			workingDirectory: process.cwd(),
			allowedAgentIds: ['lookup'],
		})) {
			tools.register(tool)
		}

		const run = await drainQuery({
			provider: provider(),
			tools,
			completionInbox: inbox,
			agentId: 'supervisor',
			agentName: 'Supervisor',
			messages: [
				{
					role: 'user',
					content: [
						'Delegate to the "lookup" agent, in the BACKGROUND (background: true), this exact prompt:',
						`"Reply with exactly this token and nothing else: ${SECRET}"`,
						'',
						'Do not wait for it with wait_for_task and do not list tasks in a loop.',
						'After launching it, just say "launched" and stop.',
						'Its result will arrive on its own; when it does, reply with the token you received.',
					].join('\n'),
					timestamp: Date.now(),
				},
			],
			workingDirectory: process.cwd(),
			runConfig: {
				model: MODEL,
				timeoutMs: 180_000,
				tokenBudget: 200_000,
				maxIterations: 6,
				maxResponseTokens: 1_024,
			},
			sessionId: asSessionId('ses_live_delegation'),
			topicId: asTopicId('top_live_delegation'),
			projectId: asProjectId('prj_live_delegation'),
			tenantId: asTenantId('tnt_live_delegation'),
		})

		const transcript = run.messages
			.filter((m) => m.role === 'user')
			.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
			.join('\n')

		// 1. The notification actually landed in the supervisor's transcript.
		expect(transcript, 'no task-notification reached the transcript').toContain('task-notification')
		expect(transcript).toContain(SECRET)

		// 2. The model read it. This is the half no fake can establish: the
		//    worker's token appears in the supervisor's own final answer, and
		//    the supervisor never had it any other way.
		expect(run.result ?? '', 'the supervisor never used what it was told').toContain(SECRET)

		// 3. It got there without polling, which is the whole complaint the
		//    fix answers — `agent_task_list` in a sleep loop was the only move
		//    on the board before this.
		const listCalls = (run.steps ?? [])
			.flatMap((s) => s.toolCalls ?? [])
			.filter((c) => c.function.name === 'agent_task_list')
		expect(listCalls.length, 'the model still had to poll').toBe(0)
	}, 300_000)

	it('still delivers the result inline when the launch is not backgrounded', async () => {
		// The path `dc16d58` protects: a blocking launch answers as its own
		// tool_result, and must NOT also arrive as an envelope.
		const gateway = liveGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		const tools = new ToolRegistry()
		for (const tool of buildCoordinatorTools({
			gateway,
			completionInbox: inbox,
			workingDirectory: process.cwd(),
			allowedAgentIds: ['lookup'],
		})) {
			tools.register(tool)
		}

		const run = await drainQuery({
			provider: provider(),
			tools,
			completionInbox: inbox,
			agentId: 'supervisor',
			agentName: 'Supervisor',
			messages: [
				{
					role: 'user',
					content: `Use create_task on the "lookup" agent with this prompt: "Reply with exactly this token and nothing else: ${SECRET}". Do NOT set background. Then report the token it returned.`,
					timestamp: Date.now(),
				},
			],
			workingDirectory: process.cwd(),
			runConfig: {
				model: MODEL,
				timeoutMs: 180_000,
				tokenBudget: 200_000,
				maxIterations: 6,
				maxResponseTokens: 1_024,
			},
			sessionId: asSessionId('ses_live_delegation'),
			topicId: asTopicId('top_live_delegation'),
			projectId: asProjectId('prj_live_delegation'),
			tenantId: asTenantId('tnt_live_delegation'),
		})

		expect(run.result ?? '').toContain(SECRET)

		const transcript = run.messages
			.filter((m) => m.role === 'user')
			.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
			.join('\n')

		// Delivered once, as a tool_result — no duplicate envelope.
		expect(transcript, 'the blocking result was announced a second time').not.toContain(
			'task-notification',
		)
	}, 300_000)
})
