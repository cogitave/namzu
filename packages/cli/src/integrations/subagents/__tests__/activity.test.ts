import { RunCancelled, type RunEvent, type RunId, type TaskHandle, type TaskId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SubagentActivityMonitor } from '../activity.js'

const runId = 'run_child' as RunId
const taskId = 'tsk_child' as TaskId

function handle(state: TaskHandle['state'] = 'completed'): TaskHandle {
	return {
		taskId,
		agentId: 'researcher',
		state,
		createdAt: 10,
		completedAt: 20,
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('the CLI sub-agent activity monitor', () => {
	it('retains bounded workflow metadata and uses explicit defaults instead of lifecycle guesses', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'researcher',
			description: 'inspect',
			prompt: 'inspect it',
			workflow: '  Release readiness  ',
			phase: '  Verify  ',
			phaseOrder: 2,
		})
		monitor.begin({
			agentId: 'worker',
			description: 'work',
			prompt: 'do it',
			phaseOrder: -1,
		})

		expect(monitor.getSnapshot()).toEqual([
			expect.objectContaining({
				workflow: 'Release readiness',
				phase: 'Verify',
				phaseOrder: 2,
			}),
			expect.objectContaining({
				workflow: 'Delegated work',
				phase: 'Work',
			}),
		])
		expect(monitor.getSnapshot()[1]).not.toHaveProperty('phaseOrder')
	})

	it('keeps the first phase order and identity when a later sibling conflicts', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'a',
			description: 'a',
			prompt: 'a',
			workflowId: 'run-parent',
			workflow: 'Audit',
			phase: 'Verify',
			phaseOrder: 2,
		})
		monitor.begin({
			agentId: 'b',
			description: 'b',
			prompt: 'b',
			workflowId: 'run-parent',
			workflow: 'Audit',
			phase: 'Verify',
			phaseOrder: 0,
		})

		const snapshot = monitor.getSnapshot()
		expect(snapshot.map((entry) => [entry.phaseId, entry.phaseOrder, entry.phaseSequence])).toEqual(
			[
				['phase-1', 2, 1],
				['phase-1', 2, 1],
			],
		)
	})

	it('groups concurrent direct calls by batch and never revives a settled earlier wave', () => {
		const monitor = new SubagentActivityMonitor()
		const first = monitor.begin({
			agentId: 'a',
			description: 'first',
			prompt: 'first',
			workflowId: 'run-parent',
		})
		const second = monitor.begin({
			agentId: 'b',
			description: 'second',
			prompt: 'second',
			workflowId: 'run-parent',
		})
		const firstBatch = monitor.getSnapshot().map((entry) => entry.batchId)
		expect(new Set(firstBatch).size).toBe(1)

		first.settle(handle())
		second.settle(handle())
		monitor.begin({
			agentId: 'c',
			description: 'third',
			prompt: 'third',
			workflowId: 'run-parent',
		})

		const snapshot = monitor.getSnapshot()
		expect(snapshot.find((entry) => entry.description === 'third')?.batchId).not.toBe(firstBatch[0])
	})

	it('shows a bounded assistant preview but never exposes reasoning text', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'worker',
			description: 'preview',
			prompt: 'preview',
		})
		tracker.onEvent({
			type: 'reasoning_delta',
			runId,
			iteration: 1,
			messageId: 'reasoning' as never,
			blockIndex: 0,
			text: 'private-chain-of-thought-marker',
		})
		expect(monitor.getSnapshot()[0]?.latestActivity).toBe('Thinking')
		expect(JSON.stringify(monitor.getSnapshot())).not.toContain('private-chain-of-thought-marker')

		tracker.onEvent({
			type: 'text_delta',
			runId,
			iteration: 1,
			messageId: 'answer' as never,
			text: 'public interim result',
		})
		expect(monitor.getSnapshot()[0]?.latestActivity).toContain('public interim result')
	})

	it('owns events that arrive before the scheduler returns a handle', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'general-purpose',
			description: 'inspect auth',
			prompt: 'read the auth flow',
		})

		tracker.onEvent({
			type: 'agent_pending',
			runId,
			taskId,
			parentAgentId: 'namzu',
			childAgentId: 'researcher',
			depth: 0,
		})
		tracker.onEvent({ type: 'run_started', runId })
		tracker.onEvent({
			type: 'text_delta',
			runId,
			iteration: 1,
			messageId: 'msg_child' as never,
			text: 'found it',
		} as RunEvent)

		const beforeHandle = monitor.getSnapshot()[0]
		expect(beforeHandle).toMatchObject({
			viewId: 'agent-1',
			taskId,
			runId,
			agentId: 'researcher',
			status: 'working',
		})
		expect(beforeHandle?.transcript[0]).toMatchObject({
			kind: 'assistant',
			text: 'found it',
		})

		tracker.settle(handle())
		expect(monitor.getSnapshot()[0]?.status).toBe('completed')
	})

	it('terminalizes a rejected creation and ignores a late successful handle', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'worker',
			description: 'work',
			prompt: 'do it',
		})

		tracker.fail(new Error('spawn refused'))
		tracker.settle(handle())

		const snapshot = monitor.getSnapshot()[0]
		expect(snapshot?.status).toBe('failed')
		expect(snapshot?.transcript[0]).toMatchObject({ text: 'spawn refused' })
	})

	it('recognizes only typed cancellation failures', () => {
		const monitor = new SubagentActivityMonitor()
		const runCancelled = monitor.begin({
			agentId: 'a',
			description: 'a',
			prompt: 'a',
		})
		const abortError = monitor.begin({
			agentId: 'b',
			description: 'b',
			prompt: 'b',
		})
		const ordinaryFailure = monitor.begin({
			agentId: 'c',
			description: 'c',
			prompt: 'c',
		})
		const abort = new Error('transport stopped')
		abort.name = 'AbortError'

		runCancelled.fail(new RunCancelled('parent'))
		abortError.fail(abort)
		ordinaryFailure.fail(new Error('cannot cancel remote job after abort negotiation'))

		expect(
			monitor.getSnapshot().map((activity) => [activity.description, activity.status]),
		).toEqual([
			['a', 'cancelled'],
			['b', 'cancelled'],
			['c', 'failed'],
		])
	})

	it('drops late events after the parent conversation changes', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'worker',
			description: 'old',
			prompt: 'old work',
		})
		monitor.reset()

		tracker.onEvent({ type: 'run_started', runId })
		tracker.settle(handle())

		expect(monitor.getSnapshot()).toEqual([])
	})

	it('bounds both a streaming row and retained transcript rows', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'worker',
			description: 'bounded',
			prompt: 'x',
		})
		tracker.onEvent({ type: 'run_started', runId })
		tracker.onEvent({
			type: 'text_delta',
			runId,
			iteration: 1,
			messageId: 'huge' as never,
			text: 'x'.repeat(50_000),
		} as RunEvent)
		for (let index = 0; index < 200; index += 1) {
			tracker.onEvent({
				type: 'tool_executing',
				runId,
				iteration: 1,
				toolUseId: `tool-${index}` as never,
				toolName: 'read',
				input: { path: `/tmp/${index}` },
				isDestructive: false,
			} as RunEvent)
		}

		const snapshot = monitor.getSnapshot()[0]
		expect(snapshot?.transcript.length).toBeLessThanOrEqual(120)
		expect(
			snapshot?.transcript.every((row) => row.text.length <= 2_048),
			'a projected row retained an unbounded event payload',
		).toBe(true)
	})

	it('coalesces high-frequency progress into one notification window', () => {
		vi.useFakeTimers()
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({
			agentId: 'worker',
			description: 'work',
			prompt: 'do it',
		})
		let notifications = 0
		monitor.subscribe(() => {
			notifications += 1
		})

		for (let index = 0; index < 30; index += 1) {
			tracker.onEvent({
				type: 'text_delta',
				runId,
				iteration: 1,
				messageId: 'stream' as never,
				text: 'x',
			} as RunEvent)
		}
		expect(notifications).toBe(0)

		vi.advanceTimersByTime(100)
		expect(notifications).toBe(1)
	})
})
