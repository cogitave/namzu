import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { buildAgentTool } from '../../../tools/coordinator/agent.js'
import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { SessionId, TaskId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { type CancelCause, RunCancelled } from '../../../types/run/cancel-cause.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	return {
		promise: new Promise<T>((settle) => {
			resolve = settle
		}),
		resolve,
	}
}

const taskId = 'task_agent_cancel' as TaskId
const launched: TaskHandle = {
	taskId,
	agentId: 'worker',
	state: 'running',
	createdAt: 0,
}

class HeldScheduler implements TaskScheduler {
	readonly creation = deferred<TaskHandle>()
	readonly wait = deferred<TaskHandle>()
	readonly createStarted = deferred<void>()
	readonly waitStarted = deferred<void>()
	readonly cancellations: Array<{ taskId: TaskId; cause?: CancelCause }> = []

	constructor(private readonly holdCreation: boolean) {}

	async createTask(): Promise<TaskHandle> {
		this.createStarted.resolve(undefined)
		return this.holdCreation ? await this.creation.promise : launched
	}

	async waitForTask(): Promise<TaskHandle> {
		this.waitStarted.resolve(undefined)
		return await this.wait.promise
	}

	async continueTask(): Promise<void> {}

	cancelTask(cancelledTaskId: TaskId, cause?: CancelCause): void {
		this.cancellations.push({ taskId: cancelledTaskId, cause })
	}

	getTask(): TaskHandle | undefined {
		return launched
	}

	listTasks(): TaskHandle[] {
		return [launched]
	}

	onTaskCompleted(): () => void {
		return () => {}
	}
}

describe('blocking Agent delegation cancellation reaches the child', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it.each([
		['while task creation is still pending', true] as const,
		['while the created task is being awaited', false] as const,
	])('cancels the exact task as parent %s', async (_label, holdCreation) => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-agent-cancel-'))
		workdirs.push(workingDirectory)
		const gateway = new HeldScheduler(holdCreation)
		const tools = new ToolRegistry()
		tools.register(
			buildAgentTool({
				gateway,
				workingDirectory,
				allowedAgentIds: ['worker'],
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_agent_cancel',
							name: 'Agent',
							args: {
								description: 'held child',
								prompt: 'wait for parent cancellation',
								subagent_type: 'worker',
							},
						},
					],
					finishReason: 'tool_calls',
				},
				{ text: 'must not need another turn' },
			],
		})
		const caller = new AbortController()
		const pending = drainQuery({
			provider,
			tools,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				permissionMode: 'auto',
			},
			toolTimeoutMs: 60_000,
			agentId: 'agent_parent',
			agentName: 'Parent Agent',
			messages: [createUserMessage('delegate this')],
			workingDirectory,
			sessionId: 'ses_agent_cancel' as SessionId,
			topicId: 'top_agent_cancel' as TopicId,
			projectId: 'prj_agent_cancel' as ProjectId,
			tenantId: 'tnt_agent_cancel' as TenantId,
			signal: caller.signal,
		})

		await gateway.createStarted.promise
		if (!holdCreation) await gateway.waitStarted.promise
		caller.abort(new RunCancelled('user'))
		const run = await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error('parent run did not settle after cancellation')), 1_000)
			}),
		])

		expect(run.status).toBe('cancelled')
		expect(provider.requests).toHaveLength(1)
		if (holdCreation) gateway.creation.resolve(launched)
		await waitFor(() => gateway.cancellations.length === 1)
		expect(gateway.cancellations).toEqual([{ taskId, cause: 'parent' }])
	})
})

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
	throw new Error('delegated task was not cancelled')
}
