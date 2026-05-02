/**
 * Behavioural contract for `buildAgentTool`:
 *
 * - Reports `success: true` only when BOTH the gateway task state and
 *   the underlying `BaseAgentResult.status` say completed.
 * - Reports `success: false` and surfaces `lastError` when either
 *   layer disagrees — the canonical bug Codex caught was that a
 *   failed subagent could be reported as successful when the gateway
 *   forwarded `state: 'completed'` from a manager that did not
 *   propagate the run's `status: 'failed'`.
 * - Returns the subagent's `result` string as the tool output on
 *   success.
 */

import { describe, expect, it } from 'vitest'

import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildAgentTool } from '../agent.js'

function makeContext(): ToolContext {
	return {
		runId: 'run_test' as never,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function fakeGateway(handle: TaskHandle, completed: TaskHandle): TaskGateway {
	return {
		async createTask() {
			return handle
		},
		async waitForTask() {
			return completed
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return completed
		},
		listTasks() {
			return [completed]
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

const taskId = 'task_subagent' as TaskId

const launched: TaskHandle = {
	taskId,
	agentId: 'sales-strategy',
	state: 'running',
	createdAt: 0,
}

describe('buildAgentTool', () => {
	it('reports success when both task state and run status say completed', async () => {
		const gateway = fakeGateway(launched, {
			...launched,
			state: 'completed',
			result: {
				runId: 'run_inner' as never,
				status: 'completed',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
				cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 } as never,
				iterations: 1,
				durationMs: 10,
				messages: [],
				result: 'final report text',
			},
			completedAt: 10,
		})

		const tool = buildAgentTool({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['sales-strategy'],
		})

		const result = await tool.execute(
			{ description: 'plan', prompt: 'go', subagent_type: 'sales-strategy' },
			makeContext(),
		)

		expect(result.success).toBe(true)
		expect(result.output).toBe('final report text')
	})

	it('reports failure when run status is failed even though task state is completed', async () => {
		const gateway = fakeGateway(launched, {
			...launched,
			state: 'completed',
			result: {
				runId: 'run_inner' as never,
				status: 'failed',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
				cost: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 } as never,
				iterations: 1,
				durationMs: 10,
				messages: [],
				lastError: 'tool budget exceeded',
			},
			completedAt: 10,
		})

		const tool = buildAgentTool({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['sales-strategy'],
		})

		const result = await tool.execute(
			{ description: 'plan', prompt: 'go', subagent_type: 'sales-strategy' },
			makeContext(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool budget exceeded')
		expect(result.error).toContain('failed')
	})

	it('reports failure when task state itself is failed', async () => {
		const gateway = fakeGateway(launched, {
			...launched,
			state: 'failed',
			result: undefined,
			completedAt: 10,
		})

		const tool = buildAgentTool({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['sales-strategy'],
		})

		const result = await tool.execute(
			{ description: 'plan', prompt: 'go', subagent_type: 'sales-strategy' },
			makeContext(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('failed')
	})

	it("does not accept a taskStore or runId — plan-task lifecycle is the parent's job", () => {
		// Compile-time pin: AgentToolOptions must NOT include `taskStore`
		// or `runId`. The Agent tool used to manage a per-call plan task
		// internally and Codex caught a leak: when the subagent failed,
		// the plan task stayed `'in_progress'` forever because
		// `TaskStatus` has no `'failed'` value to flip to. Drop the
		// integration entirely; if a host wants to track delegations as
		// plan tasks, it does so via `TaskCreate` / `TaskUpdate` on its
		// own side, where it owns the status semantics. This test
		// freezes that decision.
		const allowedOpts: Parameters<typeof buildAgentTool>[0] = {
			gateway: fakeGateway(launched, launched),
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['sales-strategy'],
			runtimeContext: undefined,
			onTaskLaunched: undefined,
		}
		expect('taskStore' in allowedOpts).toBe(false)
		expect('runId' in allowedOpts).toBe(false)
	})
})
