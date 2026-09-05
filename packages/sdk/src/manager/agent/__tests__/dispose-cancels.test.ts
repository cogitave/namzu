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
			generateSummaryId: () => 'c297e7c8-1bab-4efa-b226-75827eca1577' as SummaryId,
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
		const a = addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)
		const b = addLiveTask(
			manager,
			'5863b7eb-6c0d-40c1-9b33-408da6461561',
			'd7cb4b25-c8f3-41d8-90c5-75f49360c7dc',
		)

		manager.dispose()

		expect(a.signal.aborted).toBe(true)
		expect(b.signal.aborted).toBe(true)
	})

	it('empties its maps afterwards', () => {
		const manager = makeManager()
		addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)

		manager.dispose()

		expect((manager as unknown as { instances: Map<TaskId, unknown> }).instances.size).toBe(0)
	})

	it('is safe to call twice', () => {
		const manager = makeManager()
		addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)

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
		const child = addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)

		manager.cancelAll('37ddff8e-e13f-4e57-937f-d048fa323f5e' as RunId)

		expect(child.signal.aborted).toBe(true)
		expect(cancelCauseOf(child.signal.reason)).toBe('parent')
	})

	it('carries a named cause through instead of overriding it with the default', () => {
		const manager = makeManager()
		const child = addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)

		manager.cancelAll('37ddff8e-e13f-4e57-937f-d048fa323f5e' as RunId, 'budget')

		expect(cancelCauseOf(child.signal.reason)).toBe('budget')
	})

	it('leaves cancelAll scoped to one parent, which is its whole job', () => {
		const manager = makeManager()
		const mine = addLiveTask(
			manager,
			'db5cf4d3-8120-40b4-8680-e8a81ebbc973',
			'37ddff8e-e13f-4e57-937f-d048fa323f5e',
		)
		const theirs = addLiveTask(
			manager,
			'5863b7eb-6c0d-40c1-9b33-408da6461561',
			'd7cb4b25-c8f3-41d8-90c5-75f49360c7dc',
		)

		manager.cancelAll('37ddff8e-e13f-4e57-937f-d048fa323f5e' as RunId)

		expect(mine.signal.aborted).toBe(true)
		expect(theirs.signal.aborted).toBe(false)
	})
})
