import { describe, expect, it, vi } from 'vitest'

import type { AgentTask } from '../../types/agent/task.js'
import type { TaskId } from '../../types/ids/index.js'
import { LocalTaskScheduler } from '../local.js'

/**
 * `listTasks` skipped every task the manager had evicted.
 *
 * Terminal tasks are dropped from the manager 30 seconds after they settle,
 * and the gateway's list is built by looking each tracked id back up. A
 * task that finished 31 seconds ago therefore vanished — from the exact
 * tool whose description says to call it before declaring multi-worker work
 * done, to "confirm every launched task reached completed".
 *
 * A supervisor that fanned out five workers and checked at the end saw
 * three, and could not tell a task that was evicted from one that never
 * launched. Both look like absence.
 *
 * Eviction exists to release the heavy per-task state — messages, abort
 * controllers, spawn records — not to forget that a task existed. The
 * gateway keeps the settled summary, which is a few fields.
 */

function terminalTask(taskId: string, state: 'completed' | 'failed'): AgentTask {
	return {
		taskId: taskId as TaskId,
		agentId: 'worker',
		state,
		createdAt: 1_000,
		completedAt: 2_000,
		pendingMessages: [],
		childAbortController: new AbortController(),
		context: {},
		result: { status: state === 'failed' ? 'failed' : 'completed' },
	} as unknown as AgentTask
}

/** A manager that forgets a task, exactly as eviction does. */
function managerWith(tasks: Map<string, AgentTask>) {
	return {
		getInstance: (id: TaskId) => tasks.get(id),
		waitForCompletion: vi.fn(async () => {}),
		cancel: vi.fn(),
		spawn: vi.fn(),
	}
}

function gatewayOver(manager: ReturnType<typeof managerWith>, trackedIds: string[]) {
	const gateway = Object.create(LocalTaskScheduler.prototype) as LocalTaskScheduler
	Object.assign(gateway, {
		agentManager: manager,
		trackedTaskIds: new Set(trackedIds as TaskId[]),
		completionListeners: new Set(),
		settledHandles: new Map(),
		siblingFailurePolicy: 'continue',
	})
	return gateway
}

describe('a finished task stays listed after it is evicted', () => {
	it('lists a task the manager still holds', () => {
		const tasks = new Map([
			[
				'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
				terminalTask('db5cf4d3-8120-40b4-8680-e8a81ebbc973', 'completed'),
			],
		])
		const gateway = gatewayOver(managerWith(tasks), ['db5cf4d3-8120-40b4-8680-e8a81ebbc973'])

		gateway.rememberSettled('db5cf4d3-8120-40b4-8680-e8a81ebbc973' as TaskId)
		tasks.delete('db5cf4d3-8120-40b4-8680-e8a81ebbc973')

		const listed = gateway.listTasks()
		expect(listed).toHaveLength(1)
		expect(listed[0]?.taskId).toBe('db5cf4d3-8120-40b4-8680-e8a81ebbc973')
		expect(listed[0]?.state).toBe('completed')
	})

	it('keeps a failure visible, which is the one that matters most', () => {
		const tasks = new Map([
			[
				'5863b7eb-6c0d-40c1-9b33-408da6461561',
				terminalTask('5863b7eb-6c0d-40c1-9b33-408da6461561', 'failed'),
			],
		])
		const gateway = gatewayOver(managerWith(tasks), ['5863b7eb-6c0d-40c1-9b33-408da6461561'])

		gateway.rememberSettled('5863b7eb-6c0d-40c1-9b33-408da6461561' as TaskId)
		tasks.delete('5863b7eb-6c0d-40c1-9b33-408da6461561')

		expect(gateway.listTasks()[0]?.state).toBe('failed')
	})

	it('prefers the live task over the remembered one while both exist', () => {
		const live = terminalTask('8dc70104-0fad-4e35-a385-4312f8c78579', 'completed')
		const tasks = new Map([['8dc70104-0fad-4e35-a385-4312f8c78579', live]])
		const gateway = gatewayOver(managerWith(tasks), ['8dc70104-0fad-4e35-a385-4312f8c78579'])

		gateway.rememberSettled('8dc70104-0fad-4e35-a385-4312f8c78579' as TaskId)
		// The snapshot is now stale. The live record is authoritative: a
		// remembered handle must never shadow state still being updated —
		// a `continueTask` reopens a task the gateway already snapshotted.
		;(live as { completedAt: number }).completedAt = 9_999
		;(live as { state: string }).state = 'running'

		expect(gateway.listTasks()[0]?.completedAt).toBe(9_999)
		expect(gateway.listTasks()[0]?.state).toBe('running')
	})

	it('reports nothing for a tracked id that never settled and is already gone', () => {
		const gateway = gatewayOver(managerWith(new Map()), ['62c5cf06-4b48-44d0-9a23-18aebedb7aca'])

		// Nothing to report is still correct here — the point is that a task
		// which DID settle is not silently indistinguishable from this.
		expect(gateway.listTasks()).toHaveLength(0)
	})

	it('lists every worker after all of them are evicted', () => {
		const tasks = new Map([
			[
				'5f5d0823-8327-45fd-a288-bf8fd5f45f91',
				terminalTask('5f5d0823-8327-45fd-a288-bf8fd5f45f91', 'completed'),
			],
			[
				'03eb571b-898d-47d6-b40f-5b770fd5fca1',
				terminalTask('03eb571b-898d-47d6-b40f-5b770fd5fca1', 'failed'),
			],
			[
				'4ac175ca-d84b-4186-a41b-49ed90846838',
				terminalTask('4ac175ca-d84b-4186-a41b-49ed90846838', 'completed'),
			],
		])
		const gateway = gatewayOver(managerWith(tasks), [
			'5f5d0823-8327-45fd-a288-bf8fd5f45f91',
			'03eb571b-898d-47d6-b40f-5b770fd5fca1',
			'4ac175ca-d84b-4186-a41b-49ed90846838',
		])

		for (const id of tasks.keys()) gateway.rememberSettled(id as TaskId)
		tasks.clear()

		const listed = gateway.listTasks()
		expect(listed).toHaveLength(3)
		expect(listed.filter((h) => h.state === 'failed')).toHaveLength(1)
	})
})
