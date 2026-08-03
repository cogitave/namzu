import { describe, expect, it } from 'vitest'

import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { RunId, TaskId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ThreadManager } from '../../thread/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * `dispose()` cancelled nothing.
 *
 * It called `cancelAll('' as RunId)`, and `cancelAll` filters by
 * `context.parentRunId`. No task has an empty parent, so the filter matched
 * nothing — and the next lines cleared the instance map. Every live child
 * was released without its abort controller firing: the work kept running,
 * the budget kept draining, and nothing was left holding a reference to
 * stop it.
 *
 * The `'' as RunId` cast is the tell. A value invented to satisfy a
 * parameter usually means the parameter is the wrong one to pass.
 */

function makeManager(): AgentManager {
	const store = new InMemorySessionStore()
	return new AgentManager(new AgentRegistry(), undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => 'sum_dispose' as SummaryId,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager: new ThreadManager({
			threadStore: new InMemoryThreadStore(),
			sessionStore: store,
		}),
	})
}

/**
 * Registers a live task directly. Going through `sendMessage` would run the
 * agent to completion, and a terminal task is exactly the one `dispose` was
 * never broken for.
 */
function addLiveTask(manager: AgentManager, taskId: string, parentRunId: string): AbortController {
	const controller = new AbortController()
	const instances = (manager as unknown as { instances: Map<TaskId, unknown> }).instances
	instances.set(taskId as TaskId, {
		taskId: taskId as TaskId,
		state: 'running',
		childAbortController: controller,
		pendingMessages: [],
		context: { parentRunId: parentRunId as RunId },
	})
	return controller
}

describe('disposing the manager stops the work it was holding', () => {
	it('aborts a live child spawned under any run', () => {
		const manager = makeManager()
		// Two parents: the shape the old code could not see, because it
		// looked for one specific parent and invented the value it looked for.
		const a = addLiveTask(manager, 'task_a', 'run_1')
		const b = addLiveTask(manager, 'task_b', 'run_2')

		manager.dispose()

		expect(a.signal.aborted).toBe(true)
		expect(b.signal.aborted).toBe(true)
	})

	it('empties its maps afterwards', () => {
		const manager = makeManager()
		addLiveTask(manager, 'task_a', 'run_1')

		manager.dispose()

		expect((manager as unknown as { instances: Map<TaskId, unknown> }).instances.size).toBe(0)
	})

	it('is safe to call twice', () => {
		const manager = makeManager()
		addLiveTask(manager, 'task_a', 'run_1')

		manager.dispose()
		expect(() => manager.dispose()).not.toThrow()
	})

	it('leaves cancelAll scoped to one parent, which is its whole job', () => {
		const manager = makeManager()
		const mine = addLiveTask(manager, 'task_a', 'run_1')
		const theirs = addLiveTask(manager, 'task_b', 'run_2')

		manager.cancelAll('run_1' as RunId)

		expect(mine.signal.aborted).toBe(true)
		expect(theirs.signal.aborted).toBe(false)
	})
})
