import { describe, expect, it } from 'vitest'

import { cancelCauseOf } from '../../../types/run/cancel-cause.js'

import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { RunId, TaskId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { TopicManager } from '../../topic/lifecycle.js'
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
		threadManager: new TopicManager({
			topicStore: new InMemoryTopicStore(),
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

	it("stamps a parent's abandonment on the child's own abort reason", () => {
		// The gap NZ-TIME-01 closes. This used to abort with the bare string
		// `'canceled'`, which `abortReasonText` suppresses by name — its
		// docblock cites this exact call site — so a child could not tell an
		// operator's cancel from its parent going away.
		//
		// `'parent'` is the DEFAULT here and has no default on
		// `AbstractAgent.cancel`, because this call site IS a parent
		// abandoning its children while that one's caller could be anyone.
		const manager = makeManager()
		const child = addLiveTask(manager, 'task_a', 'run_1')

		manager.cancelAll('run_1' as RunId)

		expect(child.signal.aborted).toBe(true)
		expect(cancelCauseOf(child.signal.reason)).toBe('parent')
	})

	it('carries a named cause through instead of overriding it with the default', () => {
		const manager = makeManager()
		const child = addLiveTask(manager, 'task_a', 'run_1')

		manager.cancelAll('run_1' as RunId, 'budget')

		expect(cancelCauseOf(child.signal.reason)).toBe('budget')
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
