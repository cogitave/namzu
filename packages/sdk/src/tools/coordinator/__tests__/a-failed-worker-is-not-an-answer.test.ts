import { describe, expect, it } from 'vitest'

import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'
import { failureLabel, taskSucceeded } from '../outcome.js'

/**
 * A worker that ran and failed was reported to the model as an answer.
 *
 * Two layers can disagree. `finalizeChild` always calls `markCompleted`, so the
 * gateway's `state` is `'completed'` for a child whose run returned
 * `status: 'failed'` — and `create_task` asked only that layer. The model then
 * read the failure text as a result, the tool result carried `isError: false`,
 * and the plan task was written closed as though the work had been done.
 *
 * The correct predicate existed twenty lines away in the canonical `Agent`
 * tool, put there because a review caught it on that site. Nothing carried the
 * answer to the other one. So this file tests the shared predicate, and the
 * predicate is shared so there is no longer a second place to forget.
 */

const handle = (
	state: TaskHandle['state'],
	status?: string,
): Pick<TaskHandle, 'state' | 'result'> =>
	({ state, result: status === undefined ? undefined : { status } }) as Pick<
		TaskHandle,
		'state' | 'result'
	>

describe('success needs both authorities to agree', () => {
	it('refuses a child the gateway called complete but whose run failed', () => {
		// The exact shape the kernel produces: markCompleted was called, and
		// the run underneath it did not succeed.
		expect(taskSucceeded(handle('completed', 'failed'))).toBe(false)
	})

	it('accepts a child both layers agree on', () => {
		expect(taskSucceeded(handle('completed', 'completed'))).toBe(true)
	})

	it('accepts a gateway that reports no run status at all', () => {
		// A host gateway need not surface a run status. Treating its absence as
		// failure would break every such gateway, so absence means "this layer
		// has no opinion" rather than "it went wrong".
		expect(taskSucceeded(handle('completed'))).toBe(true)
	})

	it('refuses a child that never reached a completed state', () => {
		expect(taskSucceeded(handle('failed', 'completed'))).toBe(false)
		expect(taskSucceeded(handle('canceled'))).toBe(false)
	})
})

describe('the failure is named by whichever layer reported it', () => {
	it('uses the task state when the task itself did not complete', () => {
		// "failed" would lose the distinction a reader needs: a cancelled task
		// and a task whose run errored call for different next moves.
		expect(failureLabel(handle('canceled', 'completed'))).toBe('canceled')
	})

	it('uses the run status when the task completed but the run did not', () => {
		expect(failureLabel(handle('completed', 'failed'))).toBe('failed')
	})

	it('falls back to a plain word when neither layer said anything useful', () => {
		expect(failureLabel(handle('completed'))).toBe('failed')
	})
})

describe('create_task itself reaches the predicate', () => {
	/**
	 * The unit tests above prove the predicate is right. They would all pass
	 * with `create_task` still asking only the gateway — which is exactly the
	 * state that shipped, with the correct version sitting twenty lines away in
	 * a sibling tool.
	 *
	 * So this drives the tool.
	 */
	function toolFor(handle: TaskHandle): ToolDefinition {
		const gateway = {
			createTask: async () => ({ ...handle, state: 'running' }),
			waitForTask: async () => handle,
			getTask: () => handle,
			listTasks: () => [handle],
			cancelTask: () => undefined,
			continueTask: async () => undefined,
			onTaskCompleted: () => () => undefined,
		} as unknown as TaskGateway

		const tools = buildCoordinatorTools({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['reviewer'],
		})
		const createTask = tools.find((t) => t.name === 'create_task')
		if (!createTask) throw new Error('create_task was not built')
		return createTask
	}

	const settled = (status: string): TaskHandle =>
		({
			taskId: 'tsk_1' as TaskId,
			agentId: 'reviewer',
			// The kernel's own shape: markCompleted ran regardless of the run.
			state: 'completed',
			createdAt: 1_000,
			completedAt: 2_000,
			result: { status, result: 'the worker text', lastError: 'it blew up' },
		}) as unknown as TaskHandle

	it('reports a failed run as a failure', async () => {
		const tool = toolFor(settled('failed'))
		const result = await tool.execute(
			{ agent_id: 'reviewer', prompt: 'go', description: 'a task' },
			{ toolUseId: 'call_1' } as never,
		)

		expect(result.success, 'a failed worker was reported as an answer').toBe(false)
	})

	it('still reports a successful run as a success', async () => {
		const tool = toolFor(settled('completed'))
		const result = await tool.execute(
			{ agent_id: 'reviewer', prompt: 'go', description: 'a task' },
			{ toolUseId: 'call_1' } as never,
		)

		expect(result.success).toBe(true)
	})
})
