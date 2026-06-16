import { describe, expect, it } from 'vitest'
import type { TaskHandle } from '../../types/agent/gateway.js'
import type { AgentTaskResult, BaseAgentResult } from '../../types/agent/index.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import { countCompletedTasks, synthesizeTaskResults } from '../SupervisorAgent.js'

const RUN_ID = 'run-supervisor' as RunId
const NOW = 1_000_000

function at(results: AgentTaskResult[], index: number): AgentTaskResult {
	const entry = results[index]
	if (!entry) {
		throw new Error(`expected a task result at index ${index}, got ${results.length} results`)
	}
	return entry
}

function handle(overrides: Partial<TaskHandle> & Pick<TaskHandle, 'state'>): TaskHandle {
	return {
		taskId: 'task-1' as TaskId,
		agentId: 'worker-1',
		createdAt: NOW - 5_000,
		...overrides,
	}
}

function completedResult(): BaseAgentResult {
	return {
		runId: 'run-worker' as RunId,
		status: 'completed',
		usage: {
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: {
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
		},
		iterations: 3,
		durationMs: 4_200,
		messages: [],
		result: 'real worker output',
	}
}

describe('supervisor ledger truthfulness', () => {
	describe('synthesizeTaskResults', () => {
		it('synthesizes a FAILED result when a handle has no result, regardless of state', () => {
			// A worker that ended with no result is NOT a success even when the
			// handle reports a terminal 'completed' state — this is the exact
			// fabrication that made the supervisor claim "3 workers done" with
			// empty outputs (cowork task 02c5cf2b).
			const results = synthesizeTaskResults(
				[handle({ state: 'completed', result: undefined })],
				RUN_ID,
				NOW,
			)

			expect(results).toHaveLength(1)
			expect(at(results, 0).result.status).toBe('failed')
			expect(at(results, 0).result.status).not.toBe('completed')
			expect(at(results, 0).result.runId).toBe(RUN_ID)
			expect(at(results, 0).result.durationMs).toBe(NOW - (NOW - 5_000))
		})

		it('synthesizes a FAILED result for a genuinely failed handle', () => {
			const results = synthesizeTaskResults(
				[handle({ state: 'failed', result: undefined })],
				RUN_ID,
				NOW,
			)

			expect(at(results, 0).result.status).toBe('failed')
		})

		it('synthesizes a FAILED result for a canceled handle with no result', () => {
			const results = synthesizeTaskResults(
				[handle({ state: 'canceled', result: undefined })],
				RUN_ID,
				NOW,
			)

			expect(at(results, 0).result.status).toBe('failed')
		})

		it('preserves a present completed result verbatim (real workers unaffected)', () => {
			const real = completedResult()
			const results = synthesizeTaskResults(
				[handle({ state: 'completed', result: real })],
				RUN_ID,
				NOW,
			)

			expect(at(results, 0).result).toBe(real)
			expect(at(results, 0).result.status).toBe('completed')
			expect(at(results, 0).result.result).toBe('real worker output')
		})

		it('preserves a present failed result verbatim', () => {
			const failed: BaseAgentResult = { ...completedResult(), status: 'failed' }
			const results = synthesizeTaskResults(
				[handle({ state: 'failed', result: failed })],
				RUN_ID,
				NOW,
			)

			expect(at(results, 0).result).toBe(failed)
			expect(at(results, 0).result.status).toBe('failed')
		})
	})

	describe('countCompletedTasks', () => {
		it('excludes an absent-result handle from completedTasks', () => {
			const taskResults = synthesizeTaskResults(
				[
					handle({
						taskId: 'task-a' as TaskId,
						agentId: 'a',
						state: 'completed',
						result: undefined,
					}),
					handle({
						taskId: 'task-b' as TaskId,
						agentId: 'b',
						state: 'completed',
						result: completedResult(),
					}),
				],
				RUN_ID,
				NOW,
			)

			// Two handles, both with handle.state === 'completed', but only the
			// one that actually produced a result counts.
			expect(taskResults).toHaveLength(2)
			expect(countCompletedTasks(taskResults)).toBe(1)
		})

		it('counts every present completed result', () => {
			const taskResults = synthesizeTaskResults(
				[
					handle({
						taskId: 'task-a' as TaskId,
						agentId: 'a',
						state: 'completed',
						result: completedResult(),
					}),
					handle({
						taskId: 'task-b' as TaskId,
						agentId: 'b',
						state: 'completed',
						result: completedResult(),
					}),
				],
				RUN_ID,
				NOW,
			)

			expect(countCompletedTasks(taskResults)).toBe(2)
		})

		it('reports zero completed when no worker produced a result', () => {
			const taskResults = synthesizeTaskResults(
				[
					handle({
						taskId: 'task-a' as TaskId,
						agentId: 'a',
						state: 'completed',
						result: undefined,
					}),
					handle({ taskId: 'task-b' as TaskId, agentId: 'b', state: 'running', result: undefined }),
				],
				RUN_ID,
				NOW,
			)

			expect(countCompletedTasks(taskResults)).toBe(0)
		})
	})
})
