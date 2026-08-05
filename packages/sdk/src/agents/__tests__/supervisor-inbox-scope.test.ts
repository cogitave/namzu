import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolNameCollisionError, ToolRegistry } from '../../registry/tool/execute.js'
import { defineTool } from '../../tools/defineTool.js'
import type { TaskGateway, TaskHandle } from '../../types/agent/gateway.js'
import type { TaskId } from '../../types/ids/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * A gateway the HOST owns, which is the case that goes wrong.
 *
 * `SupervisorAgentConfig.gateway` is a first-class option, and a host that
 * built a gateway reuses it — across sequential runs, and across concurrent
 * ones. The supervisor attached a fresh `CompletionInbox` to it on every run
 * and never detached, so the subscription set only grew: three runs, three
 * live listeners, each still holding its own run's handles and each still
 * being handed every other run's completions.
 */
class HostGateway implements TaskGateway {
	readonly listeners = new Set<(h: TaskHandle) => void>()

	async createTask(): Promise<TaskHandle> {
		throw new Error('this test never launches')
	}
	async waitForTask(): Promise<TaskHandle> {
		throw new Error('this test never waits')
	}
	async continueTask(): Promise<void> {}
	cancelTask(): void {}
	getTask(): TaskHandle | undefined {
		return undefined
	}
	listTasks(): TaskHandle[] {
		return []
	}
	onTaskCompleted(cb: (h: TaskHandle) => void): () => void {
		this.listeners.add(cb)
		return () => this.listeners.delete(cb)
	}
}

/** A host tool whose name the coordinator surface also wants. */
const collidingTool = defineTool({
	name: 'create_task',
	description: 'a tool this host registered under a coordinator name',
	inputSchema: z.object({}),
	category: 'custom',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	async execute() {
		return { success: true as const, output: 'never runs' }
	},
})

async function runOnce(
	gateway: TaskGateway,
	id: string,
	options: { collide?: boolean } = {},
): Promise<void> {
	const agent = new SupervisorAgent({
		id,
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})

	const tools = new ToolRegistry()
	if (options.collide) tools.register(collidingTool)

	await agent.run(
		{
			messages: [{ role: 'user', content: 'go', timestamp: 1 }],
			workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-inbox-scope-')),
		} as never,
		{
			provider: new MockLLMProvider({ turns: [{ text: 'nothing to delegate' }] }),
			agentIds: ['worker'],
			gateway,
			tools,
			systemPrompt: 'You coordinate.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 2,
			sessionId: 'ses_scope',
			threadId: 'thd_scope',
			projectId: 'prj_scope',
			tenantId: 'tnt_scope',
		} as never,
	)
}

describe('a supervisor releases the gateway it borrowed', () => {
	it('leaves no listener behind, however many runs the host makes', async () => {
		const gateway = new HostGateway()

		for (let i = 0; i < 3; i++) {
			await runOnce(gateway, `sup_${i}`)
			expect(gateway.listeners.size, `run ${i + 1} left its completion listener attached`).toBe(0)
		}
	}, 60_000)

	it('releases it when setup throws before the run ever starts', async () => {
		// The reason it is a `finally` covering the whole body and not a line
		// after `drainQuery`. A host whose tool shares a coordinator name gets
		// `ToolNameCollisionError` from the registration loop — after the inbox
		// attached — then fixes its config and runs again. A leak of one
		// listener per run becomes one per ATTEMPT, and the attempts are what
		// there are most of.
		const gateway = new HostGateway()

		await expect(runOnce(gateway, 'sup_collide', { collide: true })).rejects.toThrow(
			ToolNameCollisionError,
		)

		expect(gateway.listeners.size, 'a run that threw left its listener attached').toBe(0)
	}, 60_000)

	it('never hands a completion to a run that did not launch it', async () => {
		// Two supervisors, one gateway. The second run's inbox is gone by the
		// time this fires, but the assertion that matters is the one above it:
		// nothing is listening that should not be.
		const gateway = new HostGateway()
		await runOnce(gateway, 'sup_a')
		await runOnce(gateway, 'sup_b')

		let delivered = 0
		for (const cb of gateway.listeners) {
			delivered += 1
			cb({
				taskId: 'tsk_foreign' as TaskId,
				agentId: 'worker',
				state: 'completed',
				createdAt: 0,
				completedAt: 1,
			} as TaskHandle)
		}

		expect(delivered).toBe(0)
	}, 60_000)
})
