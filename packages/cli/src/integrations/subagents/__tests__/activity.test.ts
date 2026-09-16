import { RunCancelled, type RunEvent, type RunId, type TaskHandle, type TaskId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
	MAX_NARRATION_CODE_UNITS,
	MAX_RETAINED_NARRATION,
	type SubagentActivity,
	SubagentActivityMonitor,
} from '../activity.js'

const runId = '4721e070-5ba2-425a-bf5a-8cc927907e9a' as RunId
const taskId = 'tsk_child' as TaskId

function usage(totalTokens: number) {
	return {
		promptTokens: totalTokens,
		completionTokens: 0,
		totalTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

const cost = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}

function handle(state: TaskHandle['state'] = 'completed'): TaskHandle {
	return {
		taskId,
		agentId: 'researcher',
		state,
		createdAt: 10,
		completedAt: 20,
	}
}

function grouping(entry: SubagentActivity | undefined) {
	return {
		workflowGroupId: entry?.workflowGroupId,
		phaseId: entry?.phaseId,
		phaseSequence: entry?.phaseSequence,
		workflow: entry?.workflow,
		phase: entry?.phase,
		phaseOrder: entry?.phaseOrder,
		phaseDetail: entry?.phaseDetail,
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

	it('a phase keeps the detail its first agent declared', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'a',
			description: 'a',
			prompt: 'a',
			workflowId: 'run-parent',
			workflow: 'Audit',
			phase: 'Verify',
			phaseDetail: 'Confirm the fix against the failing case.',
		})
		monitor.begin({
			agentId: 'b',
			description: 'b',
			prompt: 'b',
			workflowId: 'run-parent',
			workflow: 'Audit',
			phase: 'Verify',
			phaseDetail: 'A different detail from a later sibling.',
		})

		const snapshot = monitor.getSnapshot()
		expect(snapshot.map((entry) => entry.phaseDetail)).toEqual([
			'Confirm the fix against the failing case.',
			'Confirm the fix against the failing case.',
		])
	})

	it('phase detail is bounded', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'a',
			description: 'a',
			prompt: 'a',
			phase: 'Verify',
			phaseDetail: 'x'.repeat(MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS + 200),
		})
		const detail = monitor.getSnapshot()[0]?.phaseDetail
		expect(detail).toBeDefined()
		expect(detail?.length).toBeLessThanOrEqual(MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS)
		expect(detail).toContain('[clipped]')

		const withoutDetail = new SubagentActivityMonitor()
		withoutDetail.begin({ agentId: 'b', description: 'b', prompt: 'b', phase: 'Work' })
		expect(withoutDetail.getSnapshot()[0]).not.toHaveProperty('phaseDetail')
	})

	it('phase detail does not affect phase identity', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'a',
			description: 'a',
			prompt: 'a',
			workflowId: 'run-parent',
			phase: 'Verify',
			phaseDetail: 'one detail',
		})
		monitor.begin({
			agentId: 'b',
			description: 'b',
			prompt: 'b',
			workflowId: 'run-parent',
			phase: 'Verify',
			phaseDetail: 'a completely different detail',
		})

		const snapshot = monitor.getSnapshot()
		expect(snapshot[0]?.phaseId).toBe(snapshot[1]?.phaseId)
	})

	it('labels from the event and from begin() agree', () => {
		// The labels now ride the child's own `agent_pending` as well as the
		// launch call, and the monitor reads both. This pins the thing that
		// change must NOT do: for a run supplying the same labels on both
		// paths, the grouping is byte-identical to what the launch call alone
		// produced. It moves where the labels travel, not how they group.
		const launch = [
			{ agentId: 'a', description: 'a', prompt: 'a', workflowId: 'run-parent' },
			{ workflow: 'Audit', phase: 'Research', phaseOrder: 0, phaseDetail: 'Read the code.' },
		] as const
		const pending = {
			type: 'agent_pending' as const,
			runId,
			taskId,
			parentAgentId: 'namzu',
			childAgentId: 'a',
			depth: 0,
		}

		// The pre-change path: labels at launch, an event that carries none.
		const baseline = new SubagentActivityMonitor()
		baseline.begin({ ...launch[0], ...launch[1] }).onEvent(pending)

		const monitor = new SubagentActivityMonitor()
		monitor.begin({ ...launch[0], ...launch[1] }).onEvent({ ...pending, ...launch[1] })

		expect(grouping(monitor.getSnapshot()[0])).toEqual(grouping(baseline.getSnapshot()[0]))
		expect(grouping(monitor.getSnapshot()[0])).toEqual({
			workflowGroupId: JSON.stringify(['run-parent', 'workflow', 'Audit']),
			phaseId: 'phase-1',
			phaseSequence: 1,
			workflow: 'Audit',
			phase: 'Research',
			phaseOrder: 0,
			phaseDetail: 'Read the code.',
		})
	})

	it('groups a child whose labels arrive only on its event', () => {
		// A host that supplies labels to the kernel and not to the monitor —
		// every non-CLI host, since the options types are the surface it has —
		// still gets grouped work rather than one undifferentiated batch.
		const monitor = new SubagentActivityMonitor()
		monitor
			.begin({ agentId: 'a', description: 'a', prompt: 'a', workflowId: 'run-parent' })
			.onEvent({
				type: 'agent_pending',
				runId,
				taskId,
				parentAgentId: 'namzu',
				childAgentId: 'a',
				depth: 0,
				workflow: 'Audit',
				phase: 'Research',
				phaseOrder: 0,
			})

		expect(monitor.getSnapshot()[0]).toMatchObject({
			workflowGroupId: JSON.stringify(['run-parent', 'workflow', 'Audit']),
			workflow: 'Audit',
			phase: 'Research',
			phaseOrder: 0,
		})
	})

	it('keeps the launch labels when an agent never reaches its event', () => {
		// `begin()` stays the seed for exactly this: a child that fails during
		// admission emits no `agent_pending` at all, and it still belongs in
		// the phase the operator watched it launch into.
		const monitor = new SubagentActivityMonitor()
		monitor
			.begin({
				agentId: 'a',
				description: 'a',
				prompt: 'a',
				workflowId: 'run-parent',
				workflow: 'Audit',
				phase: 'Research',
			})
			.fail(new Error('no capacity'))

		expect(monitor.getSnapshot()[0]).toMatchObject({
			status: 'failed',
			workflow: 'Audit',
			phase: 'Research',
		})
	})

	it('an event naming one label leaves the others as they were launched', () => {
		// The merge is seed-under-event, so a host that names a phase and no
		// workflow does not silently drop the workflow it launched under.
		const monitor = new SubagentActivityMonitor()
		monitor
			.begin({
				agentId: 'a',
				description: 'a',
				prompt: 'a',
				workflowId: 'run-parent',
				workflow: 'Audit',
				phase: 'Research',
			})
			.onEvent({
				type: 'agent_pending',
				runId,
				taskId,
				parentAgentId: 'namzu',
				childAgentId: 'a',
				depth: 0,
				phase: 'Verify',
			})

		expect(monitor.getSnapshot()[0]).toMatchObject({
			workflow: 'Audit',
			phase: 'Verify',
			workflowGroupId: JSON.stringify(['run-parent', 'workflow', 'Audit']),
		})
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

	it('keeps a named workflow across tool batches without inventing another phase', () => {
		const monitor = new SubagentActivityMonitor()
		for (const [batchId, phase, phaseOrder] of [
			['batch-one', 'Research', 0],
			['batch-two', 'Research', 0],
			['batch-three', 'Verify', 1],
		] as const) {
			monitor.begin({
				agentId: batchId,
				description: batchId,
				prompt: batchId,
				workflowId: 'parent-one',
				workflow: 'Audit',
				batchId,
				phase,
				phaseOrder,
			})
		}
		const snapshot = monitor.getSnapshot()
		expect(new Set(snapshot.map((entry) => entry.workflowGroupId)).size).toBe(1)
		expect(snapshot[0]?.phaseId).toBe(snapshot[1]?.phaseId)
		expect(snapshot[2]?.phaseId).not.toBe(snapshot[0]?.phaseId)
	})

	it('separates repeated named work in another run and unlabelled concurrent batches', () => {
		const monitor = new SubagentActivityMonitor()
		for (const input of [
			{ workflowId: 'parent-one', workflow: 'Audit', batchId: 'batch-one' },
			{ workflowId: 'parent-two', workflow: 'Audit', batchId: 'batch-one' },
			{ workflowId: 'parent-one', batchId: 'batch-one' },
			{ workflowId: 'parent-one', batchId: 'batch-two' },
		])
			monitor.begin({ agentId: 'worker', description: 'inspect', prompt: 'inspect', ...input })
		expect(new Set(monitor.getSnapshot().map((entry) => entry.workflowGroupId)).size).toBe(4)
		expect(new Set(monitor.getSnapshot().map((entry) => entry.phaseId)).size).toBe(4)
	})

	it('keeps a queued child open until it starts and settles', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'worker', description: 'ninth', prompt: 'wait' })
		tracker.onEvent({
			type: 'agent_pending',
			runId,
			taskId,
			parentAgentId: 'namzu',
			childAgentId: 'worker',
			depth: 0,
		})
		expect(monitor.getSnapshot()[0]).toMatchObject({ status: 'queued', latestActivity: 'Queued' })
		tracker.settle({ ...handle('pending'), completedAt: undefined })
		expect(monitor.getSnapshot()[0]).not.toHaveProperty('completedAt')
		tracker.onEvent({ type: 'run_started', runId })
		expect(monitor.getSnapshot()[0]?.status).toBe('working')
		tracker.settle(handle())
		expect(monitor.getSnapshot()[0]?.status).toBe('completed')
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
			messageId: '1da50733-c95c-497d-bce1-7daba192276c' as never,
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

	it('a token usage update reaches the agent row', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'worker', description: 'work', prompt: 'do it' })
		tracker.onEvent({
			type: 'token_usage_updated',
			runId,
			usage: usage(1_234),
			cost,
		} as RunEvent)
		expect(monitor.getSnapshot()[0]?.tokens).toBe(1_234)
	})

	it('context size is not mistaken for spend', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'worker', description: 'work', prompt: 'do it' })
		tracker.onEvent({
			type: 'token_usage_updated',
			runId,
			usage: usage(9_000),
			cost,
			contextTokens: 500,
		} as RunEvent)
		expect(monitor.getSnapshot()[0]?.tokens).toBe(9_000)
	})

	it('tool calls are counted once per execution', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'worker', description: 'work', prompt: 'do it' })
		for (const toolUseId of ['tool-a', 'tool-b']) {
			tracker.onEvent({
				type: 'tool_executing',
				runId,
				iteration: 1,
				toolUseId: toolUseId as never,
				toolName: 'read',
				input: {},
				isDestructive: false,
			} as RunEvent)
			tracker.onEvent({
				type: 'tool_completed',
				runId,
				iteration: 1,
				toolUseId: toolUseId as never,
				toolName: 'read',
				isError: false,
				result: 'ok',
			} as unknown as RunEvent)
		}
		expect(monitor.getSnapshot()[0]?.toolCalls).toBe(2)
	})

	it('an agent that never reported usage has no token count', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({ agentId: 'worker', description: 'work', prompt: 'do it' })
		expect(monitor.getSnapshot()[0]).not.toHaveProperty('tokens')
	})

	it('a long correction is bounded like any other row', () => {
		const monitor = new SubagentActivityMonitor()
		const tracker = monitor.begin({ agentId: 'worker', description: 'work', prompt: 'do it' })
		tracker.onEvent({
			type: 'agent_pending',
			runId,
			taskId,
			parentAgentId: 'namzu',
			childAgentId: 'worker',
			depth: 0,
		})

		monitor.recordMessage(taskId, 'x'.repeat(5_000), 'to-child')

		const row = monitor.getSnapshot()[0]?.transcript.at(-1)
		expect(row).toMatchObject({ kind: 'system', direction: 'to-child' })
		expect(row?.text.length).toBeLessThanOrEqual(2_048)
		expect(row?.text).toContain('[clipped]')

		// An unknown task id is a silent no-op: nothing to attach the row to.
		const before = monitor.getSnapshot()
		monitor.recordMessage('no-such-task', 'lost message', 'to-child')
		expect(monitor.getSnapshot()).toEqual(before)
	})

	it('narration is bounded and evicts oldest first', () => {
		const monitor = new SubagentActivityMonitor()
		for (let index = 1; index <= MAX_RETAINED_NARRATION + 2; index += 1)
			monitor.narrate(`line ${index}`)

		expect(monitor.getNarration().map((entry) => entry.text)).toEqual([
			'line 3',
			'line 4',
			'line 5',
		])
		// Ids stay distinct across eviction, so a renderer keyed on them never
		// reuses a dropped line's row for the line that replaced it.
		expect(new Set(monitor.getNarration().map((entry) => entry.id)).size).toBe(
			MAX_RETAINED_NARRATION,
		)
	})

	it('narration clears on conversation reset', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.narrate('map returned five lenses')
		expect(monitor.getNarration()).toHaveLength(1)

		monitor.reset()

		expect(monitor.getNarration()).toEqual([])
		// A line written after the reset belongs to the new conversation and
		// cannot collide with the key the cleared one used.
		const next = monitor.narrate('verifying the storage claim')
		expect(monitor.getNarration().map((entry) => entry.text)).toEqual([
			'verifying the storage claim',
		])
		expect(next).toEqual({
			kind: 'shown',
			line: expect.objectContaining({ id: 'narration-2' }),
		})
	})

	it('a narration line is one bounded row, and an empty one is not a row at all', () => {
		const monitor = new SubagentActivityMonitor()

		expect(monitor.narrate('   ')).toEqual({ kind: 'empty' })
		expect(monitor.narrate('\u0007\u0007')).toEqual({ kind: 'empty' })
		expect(monitor.getNarration()).toEqual([])

		monitor.narrate(`two\nlines and ${'x'.repeat(MAX_NARRATION_CODE_UNITS)}`)

		const line = monitor.getNarration()[0]
		expect(line?.text).not.toContain('\n')
		expect(line?.text.length).toBeLessThanOrEqual(MAX_NARRATION_CODE_UNITS)
		expect(line?.text).toContain('[clipped]')
	})

	it('a closed monitor names itself rather than blaming the line', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.close()

		// Two different facts, and the caller reports them to the model as two
		// different answers: a blank line is the writer's to fix, a closed
		// monitor is not.
		expect(monitor.narrate('the last phase came back clean')).toEqual({ kind: 'closed' })
		expect(monitor.narrate('   ')).toEqual({ kind: 'closed' })
		expect(monitor.getNarration()).toEqual([])
	})

	it('narration reaches subscribers without waiting for a child event', () => {
		const monitor = new SubagentActivityMonitor()
		let notifications = 0
		monitor.subscribe(() => {
			notifications += 1
		})

		monitor.narrate('starting the verify phase')

		expect(notifications).toBe(1)
		// Commentary is not a child row: nothing appears in the agent snapshot.
		expect(monitor.getSnapshot()).toEqual([])
	})

	it('the resolved child model reaches the activity record', () => {
		const monitor = new SubagentActivityMonitor()
		monitor.begin({
			agentId: 'worker',
			model: 'test-child-model',
			description: 'work',
			prompt: 'do it',
		})
		expect(monitor.getSnapshot()[0]?.model).toBe('test-child-model')
	})
})
