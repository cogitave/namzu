import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import type { Agent } from '../../types/agent/core.js'
import type { SiblingFailurePolicy } from '../../types/agent/gateway.js'
import type { AgentManagerContract } from '../../types/agent/manager.js'
import type {
	AgentTask,
	AgentTaskContext,
	AgentTaskState,
	SendMessageOptions,
} from '../../types/agent/task.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * `'cancel-siblings'` was unreachable from every entry point.
 *
 * `LocalTaskGateway` has honoured the policy since it was written and the
 * cancellation machinery behind it is complete — but the policy was the fifth
 * constructor argument of a gateway the supervisor builds itself, and the
 * supervisor passed four. So every host in existence ran `'continue'`, and the
 * only way to reach the other value was to construct the gateway by hand and
 * hand it in through `config.gateway`. A policy nobody can select is not a
 * policy, and the tests it had all constructed the gateway directly, so they
 * passed while nothing upstream could turn it on.
 *
 * The assertion is deliberately the cancellation itself. Asserting that the run
 * completed would pass with the forwarding deleted — a fan-out under
 * `'continue'` completes too — and prove nothing.
 */

registerMock()

const FAILING = 'doomed' as const
const SLOW = 'patient' as const

/**
 * A manager whose slow child only settles when someone cancels it — which is
 * what an abort actually does, and what lets this run terminate at all.
 */
class FanOutManager implements AgentManagerContract {
	readonly cancelled: TaskId[] = []
	private readonly tasks = new Map<TaskId, AgentTask>()
	private releaseSlow?: () => void
	private readonly slowSettled = new Promise<void>((resolve) => {
		this.releaseSlow = resolve
	})
	private markLaunched?: () => void
	/**
	 * The doomed child does not settle until BOTH have launched.
	 *
	 * Without this the test is a race it usually wins: the sibling policy only
	 * cancels tasks the gateway is already tracking, so if the failure lands
	 * before the slow child finishes registering, nothing is cancelled, nothing
	 * releases the slow child, and the run hangs until the delegation timeout.
	 * That happened once here. A fan-out where one leg dies while another is
	 * genuinely in flight is the scenario being tested, so the harness states
	 * it instead of hoping for it.
	 */
	private readonly bothLaunched = new Promise<void>((resolve) => {
		this.markLaunched = resolve
	})

	async sendMessage(options: SendMessageOptions): Promise<AgentTask> {
		const failing = options.agentId === FAILING
		const taskId = (failing ? 'task_doomed' : 'task_patient') as TaskId
		const task = {
			taskId,
			agentId: options.agentId,
			agent: {} as Agent<never, never>,
			childAbortController: new AbortController(),
			context: {} as AgentTaskContext,
			// The failing child is `completed` at the gateway layer and
			// `failed` in its own result — the two-authority split that makes
			// this worth checking at all.
			state: (failing ? 'completed' : 'running') as AgentTaskState,
			pendingMessages: [],
			createdAt: 1,
			...(failing
				? { result: { runId: 'run_child' as RunId, status: 'failed', result: 'it broke' } }
				: {}),
		} as AgentTask

		this.tasks.set(taskId, task)
		if (this.tasks.size === 2) this.markLaunched?.()
		return task
	}

	cancel(taskId: TaskId): void {
		this.cancelled.push(taskId)
		const task = this.tasks.get(taskId)
		if (task) task.state = 'failed' as AgentTaskState
		this.releaseSlow?.()
	}

	async waitForCompletion(taskId: TaskId): Promise<void> {
		if (taskId === ('task_patient' as TaskId)) await this.slowSettled
		// The doomed child fails only once its sibling is actually in flight —
		// see `bothLaunched`. Registration happens inside `createTask` right
		// after `sendMessage` returns, so waiting a further microtask turn is
		// what puts this after it rather than racing it.
		else {
			await this.bothLaunched.then(() => undefined)
			// Safety valve, and it is what makes a REGRESSION legible. If the
			// policy never reaches the gateway, nothing cancels the slow child
			// and this run hangs until the delegation timeout — so the test
			// would report "timed out after 60s" instead of "the sibling was
			// not cancelled". Releasing it here means the assertion below is
			// what fails, and it fails in a second.
			setTimeout(() => this.releaseSlow?.(), 250).unref?.()
		}
	}

	getInstance(taskId: TaskId): AgentTask | undefined {
		return this.tasks.get(taskId)
	}

	cancelAll(): void {}
	async continueTask(): Promise<void> {}
	queueMessage(): void {}
	drainMessages() {
		return []
	}
	listByParent(): AgentTask[] {
		return []
	}
	listActive(): AgentTask[] {
		return []
	}
	getState(): AgentTaskState | undefined {
		return undefined
	}
	on(): void {}
	off(): void {}
	cleanup(): void {}
	dispose(): void {}
}

async function fanOut(policy?: SiblingFailurePolicy): Promise<FanOutManager> {
	const agentManager = new FanOutManager()
	const agent = new SupervisorAgent({
		id: 'sup_policy',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})

	await agent.run(
		{
			messages: [{ role: 'user', content: 'go', timestamp: 1 }],
			workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-sibling-policy-')),
		} as never,
		{
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								name: 'create_task',
								args: { agent_id: SLOW, prompt: 'long work', description: 'the patient one' },
							},
							{
								name: 'create_task',
								args: { agent_id: FAILING, prompt: 'doomed work', description: 'the doomed one' },
							},
						],
					},
					{ text: 'done' },
				],
			}),
			agentIds: [SLOW, FAILING],
			agentManager,
			tools: new ToolRegistry(),
			systemPrompt: 'You coordinate.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 3,
			sessionId: 'ses_policy',
			topicId: 'thd_policy',
			projectId: 'prj_policy',
			tenantId: 'tnt_policy',
			...(policy ? { siblingFailurePolicy: policy } : {}),
		} as never,
	)

	return agentManager
}

describe('a supervisor can say what a failed child means for its siblings', () => {
	it('reaches the gateway, so cancel-siblings actually stops the rest', async () => {
		const manager = await fanOut('cancel-siblings')

		expect(manager.cancelled).toContain('task_patient' as TaskId)
	}, 60_000)
})
