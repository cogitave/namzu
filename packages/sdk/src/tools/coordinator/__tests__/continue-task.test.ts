import { describe, expect, it, vi } from 'vitest'

import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { TaskId } from '../../../types/ids/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * `continue_task` was unregistered, and the comment explaining why named its
 * own expiry condition.
 *
 * It read: on a live task the manager accepts the call and pushes onto
 * `pendingMessages`, and NOTHING drains that queue during a run — so the
 * tool had no state it worked in. Terminal tasks refused it; live ones
 * accepted it into a queue nobody read. "If follow-ups on a live worker are
 * wanted, the work is a consumer for the queue."
 *
 * That consumer exists now. Until it did, a supervisor whose background
 * worker was heading the wrong way could only wait for it or kill it, and
 * killing it throws away everything it has done.
 */

const HANDLE = (over: Partial<TaskHandle> = {}): TaskHandle =>
	({
		taskId: 'task_a' as TaskId,
		agentId: 'worker',
		state: 'running',
		createdAt: 1,
		...over,
	}) as TaskHandle

function tools(over: Partial<TaskScheduler> = {}) {
	const created: TaskHandle[] = []
	const gateway = {
		listTasks: () => created,
		onTaskCompleted: () => () => {},
		createTask: async () => {
			const handle = HANDLE()
			created.push(handle)
			return handle
		},
		waitForTask: async () => HANDLE({ state: 'completed' }),
		getTask: (id: TaskId) => created.find((h) => h.taskId === id),
		cancelTask: () => {},
		continueTask: vi.fn(async () => {}),
		...over,
	} as unknown as TaskScheduler

	const built = buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['worker'],
	})
	const byName = (name: string) => built.find((t) => t.name === name)
	return { gateway, created, byName }
}

/** Launch one, so it lands in this run's own `launchedHere` set. */
async function launch(t: ReturnType<typeof tools>) {
	await t
		.byName('create_task')
		?.execute(
			{ agent_id: 'worker', prompt: 'do it', description: 'a job', background: true } as never,
			{} as never,
		)
}

describe('a supervisor can redirect a worker it launched', () => {
	it('delivers the message and does not block', async () => {
		const t = tools()
		await launch(t)

		const result = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_a', message: 'use the other file' } as never, {} as never)

		expect(result?.success).toBe(true)
		expect(t.gateway.continueTask).toHaveBeenCalledWith('task_a', 'use the other file')
		// Says the result still arrives the way it already would, so the model
		// does not follow this with a `wait_for_task` it did not need.
		expect(result?.output).toMatch(/result still arrives/)
	})

	it('refuses a task another run launched, and delivers nothing', async () => {
		// The same fencing `wait_for_task` and `agent_task_list` apply. A
		// shared gateway must not let one run steer another's worker, and the
		// spy is what separates "refused" from "refused after sending".
		const t = tools()
		t.created.push(HANDLE({ taskId: 'task_someone_else' as TaskId }))

		const result = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_someone_else', message: 'stop' } as never, {} as never)

		expect(result?.success).toBe(false)
		expect(result?.output).toMatch(/launched by this run/)
		expect(t.gateway.continueTask).not.toHaveBeenCalled()
	})

	it('does not confirm a task id the run was not supposed to know', async () => {
		// "Never existed" and "belongs to someone else" get the same answer,
		// because distinguishing them IS the leak in miniature.
		const t = tools()
		t.created.push(HANDLE({ taskId: 'task_secret' as TaskId }))

		const other = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_secret', message: 'x' } as never, {} as never)
		const absent = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_never_existed', message: 'x' } as never, {} as never)

		expect(other?.output?.replace('task_secret', 'ID')).toBe(
			absent?.output?.replace('task_never_existed', 'ID'),
		)
	})

	it('reports a terminal task as a refusal rather than throwing', async () => {
		// The manager refuses a settled task by THROWING, and a throw out of
		// `execute` reads to the model as "the platform broke" rather than
		// "that worker has finished" — which are different next moves.
		const t = tools({
			continueTask: vi.fn(async () => {
				throw new Error('Cannot continue terminal task: task_a (state: completed)')
			}),
		})
		await launch(t)

		const result = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_a', message: 'too late' } as never, {} as never)

		expect(result?.success).toBe(false)
		expect(result?.output).toMatch(/state: running|terminal/)
	})

	it('refuses a task the gateway no longer tracks', async () => {
		const t = tools()
		await launch(t)
		t.created.length = 0

		const result = await t
			.byName('continue_task')
			?.execute({ task_id: 'task_a', message: 'x' } as never, {} as never)

		expect(result?.success).toBe(false)
		expect(result?.output).toMatch(/no longer tracked/)
	})
})
