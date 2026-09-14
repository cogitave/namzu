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
