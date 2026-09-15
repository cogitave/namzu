import { expect, it } from 'vitest'
import { z } from 'zod'
import { stubTaskScheduler } from '../../../__fixtures__/task-scheduler.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { TaskHandle } from '../../../types/agent/scheduler.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'

it.each([100_000, 1_000])(
	'projects claimed results after steering without changing canonical intent (window %s)',
	async (window) => {
		const id = fixtureId.task('owned-work-context')
		const handle: TaskHandle = {
			taskId: id,
			agentId: 'reader',
			state: 'completed',
			createdAt: 1,
			result: {
				status: 'completed',
				stopReason: 'end_turn',
				result: 'Ece',
			} as TaskHandle['result'],
		}
		const inbox = new CompletionInbox()
		inbox.attach(stubTaskScheduler({ getTask: () => handle, onTaskCompleted: () => () => {} }))
		const steering = new SteeringBinding()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'deliver',
				description: 'Deliver a worker result',
				inputSchema: z.object({}),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				async execute() {
					inbox.launched(id)
					inbox.claim(id)
					steering.steer('What did we add earlier?')
					return { success: true, output: 'Worker result: Ece' }
				},
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'deliver-1', name: 'deliver', args: {} }] },
				{ text: 'The greeting. Worker result: Ece.' },
			],
		})
		const latest: string[] = []
		const run = await drainQuery({
			provider,
			tools,
			completionInbox: inbox,
			steering,
			agentId: 'parent',
			agentName: 'parent',
			tenantId: fixtureId.tenant('owned-context'),
			projectId: fixtureId.project('owned-context'),
			sessionId: fixtureId.session('owned-context'),
			topicId: fixtureId.topic('owned-context'),
			messages: [
				{ role: 'user', content: 'Ask a worker for the meeting details and report them.' },
			],
			runConfig: {
				model: 'mock',
				maxIterations: 3,
				maxResponseTokens: 100,
				tokenBudget: 10_000,
				timeoutMs: 10_000,
			},
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'disabled',
				contextWindowTokens: window,
			}),
			prepareStep: ({ latestUserMessage }) => {
				latest.push(String(latestUserMessage?.content))
				return undefined
			},
		})
		const next = provider.requests[1]?.messages ?? []
		const context = next.find((m) => String(m.content).includes('Owned delegated work'))
		if (window > 1_500) {
			expect(context?.role).toBe('user')
			expect(context?.content).toContain('delivered-to-history')
			expect(context?.content).toContain('"state":"completed"')
		} else expect(context).toBeUndefined()
		expect(next.some((m) => String(m.content).includes('Worker result: Ece'))).toBe(true)
		expect(latest.at(-1)).toBe('What did we add earlier?')
		expect(run.messages.some((m) => String(m.content).includes('Owned delegated work'))).toBe(false)
		expect(run.stopReason).toBe('end_turn')
		inbox.close()
	},
)

it('keeps a task launched before the turn visible after the turn launches many more', async () => {
	// Regression for the FIFO-on-launch-count bug: a task announced early used
	// to fall out of `describeOwnedWork` purely because sixteen more tasks were
	// LAUNCHED afterward, whether or not any of them had actually finished.
	const runningId = fixtureId.task('owned-work-context-running')
	const settledById = new Map<string, TaskHandle>()
	const inbox = new CompletionInbox()
	inbox.attach(
		stubTaskScheduler({
			getTask: (taskId) => settledById.get(taskId),
			onTaskCompleted: () => () => {},
		}),
	)
	// Launched before this turn's request is even built, and never settles —
	// the scheduler genuinely has nothing to report for it.
	inbox.launched(runningId)

	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'delegate_more',
			description: 'Launch several more workers that finish immediately',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				for (let i = 0; i < 20; i++) {
					const laterId = fixtureId.task(`owned-work-context-later-${i}`)
					settledById.set(laterId, {
						taskId: laterId,
						agentId: 'worker',
						state: 'completed',
						createdAt: 1,
						result: {
							status: 'completed',
							stopReason: 'end_turn',
							result: `r${i}`,
						} as TaskHandle['result'],
					})
					inbox.launched(laterId)
				}
				return { success: true, output: 'launched 20 more workers' }
			},
		}),
	)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'delegate-1', name: 'delegate_more', args: {} }] },
			{ text: 'Done.' },
		],
	})
	await drainQuery({
		provider,
		tools,
		completionInbox: inbox,
		agentId: 'parent',
		agentName: 'parent',
		tenantId: fixtureId.tenant('owned-context-running'),
		projectId: fixtureId.project('owned-context-running'),
		sessionId: fixtureId.session('owned-context-running'),
		topicId: fixtureId.topic('owned-context-running'),
		messages: [{ role: 'user', content: 'Delegate more work and report back.' }],
		runConfig: {
			model: 'mock',
			maxIterations: 3,
			maxResponseTokens: 100,
			tokenBudget: 10_000,
			timeoutMs: 10_000,
		},
		compactionConfig: CompactionConfigSchema.parse({
			strategy: 'disabled',
			contextWindowTokens: 100_000,
		}),
	})
	const next = provider.requests[1]?.messages ?? []
	const context = next.find((m) => String(m.content).includes('Owned delegated work'))
	expect(context?.role).toBe('user')
	// Still named, even though 20 more tasks launched after it — the old FIFO
	// would have evicted it from the projection by now.
	expect(context?.content).toContain(`"taskId":"${runningId}"`)
	// Genuinely unresolved: the stub gateway has nothing recorded for it.
	expect(context?.content).toContain('"state":"unknown"')
	inbox.close()
})
