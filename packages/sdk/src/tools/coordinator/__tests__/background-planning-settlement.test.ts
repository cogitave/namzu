import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlanManager } from '../../../manager/plan/lifecycle.js'
import { CompletionInbox } from '../../../scheduler/completion-inbox.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { generateSessionId, generateTaskId, generateTurnId } from '../../../utils/id.js'
import { DELEGATION_TIMEOUT_MS, buildCoordinatorTools } from '../index.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function fixture(options: { alreadyCompleted?: boolean; inbox?: boolean } = {}) {
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	const store = new InMemoryTaskStore()
	function approvedPlan() {
		const plan = new PlanManager({ sessionId, turnId })
		plan.startGenerating('Review changes')
		plan.addStep({
			id: 'step_1',
			description: 'Review changes',
			agentId: 'reviewer',
			dependsOn: [],
			order: 1,
		})
		plan.markReady()
		plan.approve()
		plan.startExecution()
		return plan
	}
	const plan = approvedPlan()
	let currentPlan = plan
	const result = deferred<TaskHandle>()
	const waiting = deferred<void>()
	let handle: TaskHandle = {
		taskId: generateTaskId(),
		agentId: 'reviewer',
		state: options.alreadyCompleted ? 'completed' : 'running',
		createdAt: 1,
		...(options.alreadyCompleted
			? {
					completedAt: 2,
					result: { status: 'completed', result: 'Reviewed' } as TaskHandle['result'],
				}
			: {}),
	}
	const listeners = new Set<(handle: TaskHandle) => void>()
	const gateway: TaskScheduler = {
		createTask: vi.fn(async () => {
			if (options.alreadyCompleted) for (const listener of listeners) listener(handle)
			return handle
		}),
		waitForTask: vi.fn(() => {
			waiting.resolve()
			return options.alreadyCompleted ? Promise.resolve(handle) : result.promise
		}),
		continueTask: async () => {},
		cancelTask: () => {},
		getTask: () => handle,
		listTasks: () => [handle],
		onTaskCompleted: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
	const inbox = options.inbox === false ? undefined : new CompletionInbox()
	inbox?.attach(gateway)
	const tools = buildCoordinatorTools({
		gateway,
		completionInbox: inbox,
		taskStore: store,
		sessionId,
		turnId,
		workingDirectory: '/tmp/namzu-task-domain-audit',
		allowedAgentIds: ['reviewer'],
		getPlanManager: () => currentPlan,
	})
	const named = (name: string) => {
		const tool = tools.find((tool) => tool.name === name)
		if (!tool) throw new Error(`Coordinator did not expose ${name}`)
		return tool
	}
	const controller = new AbortController()
	const context = {
		sessionId,
		turnId,
		workingDirectory: '/tmp/namzu-task-domain-audit',
		abortSignal: controller.signal,
		env: {},
		log: () => {},
	} as ToolContext
	return {
		store,
		plan,
		inbox,
		gateway,
		controller,
		waiting,
		get handle() {
			return handle
		},
		launch: (background = true) =>
			named('create_task').execute(
				{
					agent_id: 'reviewer',
					prompt: 'Review changes',
					description: 'Review changes',
					plan_step_id: 'step_1',
					background,
				},
				context,
			),
		wait: () => named('wait_for_task').execute({ task_id: handle.taskId }, context),
		replacePlan: () => {
			currentPlan = approvedPlan()
			return currentPlan
		},
		finish: (
			state: TaskHandle['state'] = 'completed',
			status: string | undefined = 'completed',
		) => {
			handle = {
				...handle,
				state,
				completedAt: 2,
				result: { ...(status ? { status } : {}), result: 'Reviewed' } as TaskHandle['result'],
			}
			for (const listener of listeners) listener(handle)
			result.resolve(handle)
		},
		announceAgain: () => {
			for (const listener of listeners) listener(handle)
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('a worker settles the planning work it carries', () => {
	it('settles both linked records when already complete before launch registration', async () => {
		const f = fixture({ alreadyCompleted: true })
		await f.launch()
		expect((await f.inbox?.drainAsync())?.map((result) => result.taskId)).toEqual([f.handle.taskId])
		expect({
			planningTask: (await f.store.list())[0]?.status,
			planStep: f.plan.active?.steps[0]?.status,
		}).toEqual({ planningTask: 'completed', planStep: 'completed' })
		f.announceAgain()
		expect(await f.inbox?.drainAsync()).toEqual([])
	})

	it('uses the returned terminal handle even if the gateway no longer supports waiting on it', async () => {
		const f = fixture({ alreadyCompleted: true })
		vi.spyOn(f.gateway, 'waitForTask').mockRejectedValue(new Error('Task was already evicted'))
		await f.launch()
		expect((await f.inbox?.drainAsync())?.map((handle) => handle.taskId)).toEqual([f.handle.taskId])
		expect((await f.store.list())[0]?.status).toBe('completed')
		expect(f.plan.active?.steps[0]?.status).toBe('completed')
		expect(f.gateway.waitForTask).not.toHaveBeenCalled()
	})

	it.each([
		['completed', 'completed', 'completed'],
		['completed', undefined, 'completed'],
		['completed', 'partial', 'failed'],
		['completed', 'failed', 'failed'],
		['failed', 'failed', 'failed'],
		['canceled', 'cancelled', 'failed'],
		['rejected', undefined, 'failed'],
	] as const)(
		'keeps worker %s / turn %s outcome as planning %s',
		async (state, status, expected) => {
			const f = fixture()
			const launched = await f.launch()
			f.finish(state, status)
			await f.inbox?.drainAsync()
			expect((await f.store.list())[0]?.status).toBe(expected)
			expect(f.plan.active?.steps[0]?.status).toBe(expected)
			expect((launched.data as Record<string, unknown> | undefined)?.plan_task_id).not.toBe(
				f.handle.taskId,
			)
		},
	)

	it('persists before notification or inline retrieval and settles only once', async () => {
		const f = fixture()
		const persistence = deferred<void>()
		const entered = deferred<void>()
		const update = f.store.update.bind(f.store)
		const writes = vi.spyOn(f.store, 'update').mockImplementation(async (id, input) => {
			if (input.status === 'completed') {
				entered.resolve()
				await persistence.promise
			}
			return update(id, input)
		})
		await f.launch()
		f.finish()
		await entered.promise
		expect(f.inbox?.drain()).toEqual([])
		expect((await f.store.list())[0]?.status).toBe('in_progress')
		expect(f.plan.active?.steps[0]?.status).toBe('running')
		const inline = f.wait()
		persistence.resolve()
		expect((await inline).success).toBe(true)
		f.announceAgain()
		expect(await f.inbox?.drainAsync()).toEqual([])
		expect(writes.mock.calls.filter(([, input]) => input.status === 'completed')).toHaveLength(1)
		expect(f.gateway.waitForTask).toHaveBeenCalledTimes(1)
	})

	it('updates the original manager when the host selects another plan', async () => {
		const f = fixture()
		await f.launch()
		const replacement = f.replacePlan()
		f.finish()
		await f.inbox?.drainAsync()
		expect(f.plan.active?.steps[0]?.status).toBe('completed')
		expect(replacement.active?.steps[0]?.status).toBe('pending')
	})

	it('never writes a replacement plan with a reused step id in the same manager', async () => {
		const f = fixture()
		await f.launch()
		f.plan.startGenerating('A different plan')
		f.plan.addStep({
			id: 'step_1',
			description: 'Different work',
			agentId: 'reviewer',
			dependsOn: [],
			order: 1,
		})
		f.finish()
		await f.inbox?.drainAsync()
		expect(f.plan.active?.steps[0]?.status).toBe('pending')
		expect((await f.store.list())[0]?.status).toBe('completed')
	})

	it('keeps tracking after the bounded foreground wait expires', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const launch = f.launch(false)
		await f.waiting.promise
		await vi.advanceTimersByTimeAsync(DELEGATION_TIMEOUT_MS)
		expect(((await launch).data as Record<string, unknown> | undefined)?.timed_out).toBe('wall')
		expect((await f.store.list())[0]?.status).toBe('in_progress')
		f.finish()
		expect((await f.inbox?.drainAsync())?.map((handle) => handle.taskId)).toEqual([f.handle.taskId])
		expect((await f.store.list())[0]?.status).toBe('completed')
		expect(f.plan.active?.steps[0]?.status).toBe('completed')
	})

	it('settles even when the caller abandoned the inline result', async () => {
		const f = fixture()
		const launch = f.launch(false)
		await f.waiting.promise
		f.controller.abort()
		f.finish()
		expect(((await launch).data as Record<string, unknown> | undefined)?.abandoned).toBe(true)
		expect((await f.inbox?.drainAsync())?.map((handle) => handle.taskId)).toEqual([f.handle.taskId])
		expect((await f.store.list())[0]?.status).toBe('completed')
		expect(f.plan.active?.steps[0]?.status).toBe('completed')
	})

	it('retains the result and reports persistence failure instead of false completion', async () => {
		const f = fixture()
		const persistence = deferred<void>()
		const entered = deferred<void>()
		const update = f.store.update.bind(f.store)
		vi.spyOn(f.store, 'update').mockImplementation(async (id, input) => {
			if (input.status === 'completed') {
				entered.resolve()
				await persistence.promise
			}
			return update(id, input)
		})
		await f.launch()
		f.finish()
		await entered.promise
		const drain = f.inbox?.drainAsync()
		const failure = new Error('Task storage refused the settlement')
		persistence.reject(failure)
		await expect(drain).rejects.toBe(failure)
		expect(() => f.inbox?.drain()).toThrow(failure)
		expect(await f.wait()).toMatchObject({
			success: false,
			error: expect.stringContaining(failure.message),
		})
		expect(f.inbox?.hasPendingWork).toBe(true)
		expect((await f.store.list())[0]?.status).toBe('in_progress')
		expect(f.plan.active?.steps[0]?.status).toBe('running')
	})

	it('uses the same settlement on a foreground-only composition', async () => {
		const f = fixture({ inbox: false, alreadyCompleted: true })
		expect((await f.launch(false)).success).toBe(true)
		expect((await f.store.list())[0]?.status).toBe('completed')
		expect(f.plan.active?.steps[0]?.status).toBe('completed')
	})

	it('settles delegation admission failure without claiming the worker dispatch outcome', async () => {
		const f = fixture()
		vi.spyOn(f.gateway, 'createTask').mockRejectedValue(new Error('Scheduler admission refused'))
		const result = await f.launch()
		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining('Scheduler admission refused'),
		})
		expect((await f.store.list())[0]).toMatchObject({
			status: 'failed',
			description: expect.stringContaining('Delegation admission failed'),
		})
		expect(f.plan.active?.steps[0]).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('Scheduler admission refused'),
		})
		expect((await f.store.list())[0]?.description).toContain('dispatch outcome is not established')
		expect(f.gateway.waitForTask).not.toHaveBeenCalled()
		expect(f.inbox?.hasPendingWork).toBe(false)
	})

	it('reports both admission and tracking failures when the failure record cannot be saved', async () => {
		const f = fixture()
		vi.spyOn(f.gateway, 'createTask').mockRejectedValue(new Error('Scheduler admission refused'))
		const update = f.store.update.bind(f.store)
		vi.spyOn(f.store, 'update').mockImplementation((id, input) => {
			if (input.status === 'failed')
				return Promise.reject(new Error('Tracking storage unavailable'))
			return update(id, input)
		})
		const result = await f.launch()
		expect(result.success).toBe(false)
		expect(result.error).toContain('Scheduler admission refused')
		expect(result.error).toContain('Planning settlement failed: Tracking storage unavailable')
		expect((await f.store.list())[0]?.status).toBe('in_progress')
		expect(f.plan.active?.steps[0]?.status).toBe('failed')
		expect(f.gateway.waitForTask).not.toHaveBeenCalled()
	})

	it('does not start a worker when a directly supplied background flag has no delivery channel', async () => {
		const f = fixture({ inbox: false })
		expect((await f.launch()).success).toBe(false)
		expect(f.gateway.createTask).not.toHaveBeenCalled()
	})
})
