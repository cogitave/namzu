/**
 * Behavioural contract for the `agent_task_list` coordinator tool:
 *
 * - Returns every task the gateway knows about, with state + timing.
 * - Filters by state when the input narrows it.
 * - Emits a per-state summary in the data payload — what the supervisor
 *   reads to decide "done vs not done" before calling verify_outputs.
 * - Distinct from the plan-task store's `task_list` (subject/blockedBy);
 *   listing them under different names avoids ToolRegistry collisions when
 *   both surfaces are wired into the same agent.
 */

import { describe, expect, it } from 'vitest'

import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

function makeContext(): ToolContext {
	return {
		runId: 'run_test' as never,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function gatewayWith(handles: TaskHandle[]): TaskGateway {
	return {
		async createTask() {
			throw new Error('not used')
		},
		async waitForTask() {
			throw new Error('not used')
		},
		async continueTask() {},
		cancelTask() {},
		getTask(id) {
			return handles.find((h) => h.taskId === id)
		},
		listTasks() {
			return handles
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

function handle(input: {
	id: string
	agentId: string
	state: TaskHandle['state']
	createdAt: number
	completedAt?: number
	lastError?: string
}): TaskHandle {
	return {
		taskId: input.id as TaskId,
		agentId: input.agentId,
		state: input.state,
		createdAt: input.createdAt,
		completedAt: input.completedAt,
		result: input.lastError
			? ({
					runId: 'run_x' as never,
					status: input.state === 'failed' ? 'failed' : 'completed',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
					cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 } as never,
					iterations: 1,
					durationMs: 0,
					messages: [],
					result: '',
					lastError: input.lastError,
				} as never)
			: undefined,
	}
}

function findAgentTaskList(gateway: TaskGateway) {
	const tools = buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['solution-architecture', 'enterprise-architecture'],
	})
	const t = tools.find((tool) => tool.name === 'agent_task_list')
	if (!t) throw new Error('agent_task_list tool missing from coordinator builder')
	return t
}

describe('coordinator agent_task_list tool', () => {
	it('lists every task with state, agent, and timing', async () => {
		const gateway = gatewayWith([
			handle({ id: 'task_a', agentId: 'solution-architecture', state: 'completed', createdAt: 0, completedAt: 5000 }),
			handle({ id: 'task_b', agentId: 'enterprise-architecture', state: 'running', createdAt: 1000 }),
			handle({ id: 'task_c', agentId: 'solution-architecture', state: 'failed', createdAt: 2000, completedAt: 4000, lastError: 'bash exit 1' }),
		])

		const tool = findAgentTaskList(gateway)
		const result = await tool.execute({}, makeContext())
		expect(result.success).toBe(true)
		expect(result.output).toMatch(/Tasks: 3 total/)
		expect(result.output).toMatch(/1 running/)
		expect(result.output).toMatch(/1 completed/)
		expect(result.output).toMatch(/1 failed/)
		expect(result.output).toMatch(/task_a → solution-architecture \[completed\]/)
		expect(result.output).toMatch(/task_c .* error: bash exit 1/)
		const data = result.data as { items: unknown[]; summary: { total: number } }
		expect(data.summary.total).toBe(3)
		expect(data.items).toHaveLength(3)
	})

	it('filters by state', async () => {
		const gateway = gatewayWith([
			handle({ id: 'task_a', agentId: 'solution-architecture', state: 'completed', createdAt: 0, completedAt: 5000 }),
			handle({ id: 'task_b', agentId: 'enterprise-architecture', state: 'running', createdAt: 1000 }),
		])

		const tool = findAgentTaskList(gateway)
		const result = await tool.execute({ state: 'running' }, makeContext())
		expect(result.success).toBe(true)
		const data = result.data as { items: Array<{ task_id: string }> }
		expect(data.items).toHaveLength(1)
		expect(data.items[0]?.task_id).toBe('task_b')
		expect(result.output).not.toMatch(/task_a/)
	})

	it('handles an empty gateway', async () => {
		const tool = findAgentTaskList(gatewayWith([]))
		const result = await tool.execute({}, makeContext())
		expect(result.success).toBe(true)
		expect(result.output).toMatch(/Tasks: 0 total/)
		expect(result.output).toMatch(/no tasks launched yet/)
	})

	it('does not collide with the plan-task store `task_list` tool name', async () => {
		// Regression: an earlier cut registered the agent-task gateway
		// inspector under the same `task_list` name as the plan-task store
		// list tool, which would shadow one of them in any agent that wired
		// both surfaces together. The agent inspector now lives under
		// `agent_task_list`; this test guards the rename.
		const coordinatorTools = buildCoordinatorTools({
			gateway: gatewayWith([]),
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['solution-architecture'],
		})
		const names = coordinatorTools.map((t) => t.name)
		expect(names).toContain('agent_task_list')
		expect(names).not.toContain('task_list')
	})
})
