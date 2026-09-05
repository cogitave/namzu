import { describe, expect, it } from 'vitest'
import { TokenBudget } from '../../run/token-budget.js'
import { generateRunId as budgetRunId } from '../../utils/id.js'

import type { AgentManagerContract } from '../../types/agent/manager.js'
import type { AgentTask, AgentTaskContext } from '../../types/agent/task.js'
import type { AgentId, TaskId } from '../../types/ids/index.js'
import { LocalTaskScheduler } from '../local.js'

/**
 * The gateway's two ledgers — `trackedTaskIds` and `settledHandles` — had `add`
 * and `set` and no removal anywhere. The doc called them "bounded by the number
 * the gateway itself launched", which is true and is not a bound: a gateway
 * built per run is bounded by that run, but `SupervisorAgentConfig.gateway`
 * lets a host supply its own, and a long-lived host reusing one accumulates an
 * id and a settled handle for every task it ever launched.
 *
 * Eviction is oldest-first and takes both together. Dropping a tracked id while
 * keeping its handle — or the reverse — would make a task that ran read as one
 * that never launched, which is precisely the defect the settled-handle map was
 * added to fix.
 */

const CAP = 1_000

class CountingManager {
	private n = 0

	async sendMessage(): Promise<AgentTask> {
		this.n++
		return { taskId: `tsk_${this.n}` as TaskId, state: 'running' } as AgentTask
	}
	async waitForCompletion(): Promise<void> {}
	getInstance(): AgentTask | undefined {
		return undefined
	}
	cancel(): void {}
}

function context(): AgentTaskContext {
	return {
		parentRunId: '5eba9421-a64b-4bf1-94b0-b0c3985daf28' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: TokenBudget.create(1_000_000, budgetRunId()),
		tenantId: '0655203a-fe49-4e68-bb77-0f3889421e4c' as never,
		sessionId: '314d67db-e2b9-420a-9f10-cee9b361a899' as never,
		projectId: '8e77b3c0-cb1f-4ed2-b6d4-fd16fff77c89' as never,
	} as unknown as AgentTaskContext
}

function tracked(gateway: LocalTaskScheduler): Set<TaskId> {
	return (gateway as unknown as { trackedTaskIds: Set<TaskId> }).trackedTaskIds
}

function settled(gateway: LocalTaskScheduler): Map<TaskId, unknown> {
	return (gateway as unknown as { settledHandles: Map<TaskId, unknown> }).settledHandles
}

async function launch(gateway: LocalTaskScheduler, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await gateway.createTask({
			agentId: 'w' as AgentId,
			prompt: 'go',
			workingDirectory: '/tmp',
		} as never)
	}
}

describe('a gateway that outlives its run forgets the oldest', () => {
	it('keeps every task of a run that never reaches the cap', async () => {
		// The control, and the case that must not change: a supervisor reading
		// its listing at the end of a run sees everything it launched.
		const gateway = new LocalTaskScheduler(
			new CountingManager() as unknown as AgentManagerContract,
			context(),
		)

		await launch(gateway, 50)

		expect(tracked(gateway).size).toBe(50)
	})

	it('stops growing once the cap is passed', async () => {
		const gateway = new LocalTaskScheduler(
			new CountingManager() as unknown as AgentManagerContract,
			context(),
		)

		await launch(gateway, CAP + 25)

		expect(tracked(gateway).size).toBe(CAP)
	})

	it('drops the oldest, not the newest', async () => {
		// A cap that evicted the most recent would keep the ledger small and
		// answer every question wrongly.
		const gateway = new LocalTaskScheduler(
			new CountingManager() as unknown as AgentManagerContract,
			context(),
		)

		await launch(gateway, CAP + 3)

		const ids = tracked(gateway)
		expect(ids.has('tsk_1' as TaskId)).toBe(false)
		expect(ids.has('tsk_3' as TaskId)).toBe(false)
		expect(ids.has(`tsk_${CAP + 3}` as TaskId)).toBe(true)
	})

	it('never keeps a settled handle for an id it has forgotten', async () => {
		// The two must be evicted together. A handle whose id is gone is
		// unreachable through `listTasks`, which walks the ids — so it would be
		// retained memory serving nothing, and the leak would survive its own
		// fix.
		const gateway = new LocalTaskScheduler(
			new CountingManager() as unknown as AgentManagerContract,
			context(),
		)
		await launch(gateway, 10)
		const handles = settled(gateway)
		for (let i = 1; i <= 10; i++) handles.set(`tsk_${i}` as TaskId, { id: i })

		await launch(gateway, CAP + 5)

		const ids = tracked(gateway)
		for (const id of handles.keys()) {
			expect({ id, trackedToo: ids.has(id) }).toEqual({ id, trackedToo: true })
		}
	})
})
