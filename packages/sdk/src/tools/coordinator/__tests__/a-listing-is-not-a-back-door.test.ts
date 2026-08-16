import { describe, expect, it } from 'vitest'

import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * A supervisor could read a sibling run's worker output by listing.
 *
 * `SupervisorAgentConfig.gateway` exists so a host can hand the SAME gateway to
 * several runs, which makes `listTasks()` gateway-wide by design.
 * `agent_task_list` handed that straight to the model — including each task's
 * `result`, the worker's actual output — and `wait_for_task` had the same reach
 * through `getTask`.
 *
 * `CompletionInbox` closed exactly this on the push side, because
 * `onTaskCompleted` is a broadcast and a shared gateway would otherwise hand
 * each supervisor the other's completions. The pull side kept no such record
 * and asked the gateway directly, so the same leak stayed open through a
 * different door.
 */

const AGENTS = ['reviewer', 'researcher']

function makeContext(): ToolContext {
	return {
		runId: 'run_scope' as never,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** One gateway, as a host sharing it between two supervisors would have. */
function sharedGateway() {
	const handles = new Map<string, TaskHandle>()
	let seq = 0

	const gateway = {
		createTask: async (opts: { agentId: string }) => {
			seq += 1
			const taskId = `tsk_${seq}` as TaskId
			const handle: TaskHandle = {
				taskId,
				agentId: opts.agentId,
				state: 'completed',
				createdAt: 1_000,
				completedAt: 2_000,
				result: {
					status: 'completed',
					result: `output of ${opts.agentId} on ${taskId}`,
				} as TaskHandle['result'],
			}
			handles.set(taskId, handle)
			return handle
		},
		waitForTask: async (taskId: TaskId) => handles.get(taskId) as TaskHandle,
		getTask: (taskId: TaskId) => handles.get(taskId),
		listTasks: () => [...handles.values()],
		cancelTask: () => undefined,
		continueTask: async () => undefined,
		onTaskCompleted: () => () => {},
	} as unknown as TaskScheduler

	return gateway
}

/** A run's own coordinator surface over a gateway it may be sharing. */
function runOver(gateway: TaskScheduler) {
	const tools = buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds: AGENTS,
	})
	const named = (name: string) => {
		const t = tools.find((tool) => tool.name === name)
		if (!t) throw new Error(`${name} missing from coordinator builder`)
		return t
	}
	return {
		launch: (agentId: string) =>
			named('create_task').execute(
				{ agent_id: agentId, prompt: 'work', description: `${agentId} work` },
				makeContext(),
			),
		list: () => named('agent_task_list').execute({}, makeContext()),
		waitFor: (taskId: string) => named('wait_for_task').execute({ task_id: taskId }, makeContext()),
	}
}

describe('one run cannot read another run through the listing', () => {
	it('lists only the tasks this run launched', async () => {
		const gateway = sharedGateway()
		const first = runOver(gateway)
		const second = runOver(gateway)

		await first.launch('reviewer')
		await second.launch('researcher')

		const listed = await second.list()

		// Its own, yes.
		expect(listed.output).toContain('tsk_2')
		// The sibling's task, and — the part that matters — the sibling's
		// worker output, which the listing renders inline.
		expect(listed.output).not.toContain('tsk_1')
		expect(listed.output).not.toContain('output of reviewer')
	})

	it('counts only its own in the summary', async () => {
		// The summary is what a supervisor reads to decide "done vs not done".
		// A total that includes a sibling's tasks is a wrong answer to that
		// question even when no output leaks with it.
		const gateway = sharedGateway()
		const first = runOver(gateway)
		const second = runOver(gateway)

		await first.launch('reviewer')
		await first.launch('reviewer')
		await second.launch('researcher')

		const listed = await second.list()
		const data = listed.data as { summary: { total: number }; items: unknown[] }

		expect(data.summary.total).toBe(1)
		expect(data.items).toHaveLength(1)
	})

	it('refuses to wait on a task another run launched', async () => {
		const gateway = sharedGateway()
		const first = runOver(gateway)
		const second = runOver(gateway)

		await first.launch('reviewer')

		const waited = await second.waitFor('tsk_1')

		expect(waited.success).toBe(false)
		expect(waited.output).not.toContain('output of reviewer')
	})

	it('says the same thing about a task that never existed', async () => {
		// The refusal must not distinguish "belongs to someone else" from
		// "never existed". Confirming a real id to a run that should not know
		// it is the leak in miniature.
		const gateway = sharedGateway()
		const first = runOver(gateway)
		const second = runOver(gateway)

		await first.launch('reviewer')

		const sibling = await second.waitFor('tsk_1')
		const fictional = await second.waitFor('tsk_9999')

		expect(sibling.output).toBe(fictional.output.replace('tsk_9999', 'tsk_1'))
	})

	it('still lets a run wait on its own task', async () => {
		// The scope has to be a filter, not a wall — a run that launched a task
		// must still be able to read it back, or the fix breaks delegation.
		const gateway = sharedGateway()
		const only = runOver(gateway)

		await only.launch('reviewer')
		const waited = await only.waitFor('tsk_1')

		expect(waited.success).toBe(true)
	})
})
