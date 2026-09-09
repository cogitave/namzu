import {
	type PrepareStepContext,
	type Task,
	type TaskStore,
	generateRunId,
	generateTaskId,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { createTaskContextStep } from './task-context.js'
const runId = generateRunId()
const tenantId = generateTenantId()
const context = (remainingTokens = 10000): PrepareStepContext => ({
	runId,
	stepNumber: 1,
	messages: [],
	steps: [],
	prepared: { system: 'Host guidance' },
	contextBudget: { remainingTokens, windowTokens: 100000 },
})
const task = (overrides: Partial<Task> = {}): Task => ({
	id: generateTaskId(),
	runId,
	tenantId,
	subject: 'Inspect implementation',
	status: 'pending',
	blocks: [],
	blockedBy: [],
	createdAt: 1,
	...overrides,
})
const store = (list: TaskStore['list']) => ({ list }) as TaskStore
const data = (system: string) => JSON.parse(system.split('\n').at(-1)!)
afterEach(() => vi.useRealTimers())
it('refreshes unfinished work after history loss without importing other scopes', async () => {
	const current = task()
	const list = vi.fn(async () => [
		current,
		task({ runId: generateRunId(), subject: 'Other run secret' }),
		task({ tenantId: generateTenantId(), subject: 'Other tenant secret' }),
		task({ tenantId: undefined, subject: 'Unscoped secret' }),
	])
	const step = createTaskContextStep(store(list), tenantId)
	const first = await step(context())
	expect(first?.system).toContain('Host guidance')
	expect(first?.system).not.toContain('secret')
	expect(data(first!.system!).tasks).toHaveLength(1)
	expect(list).toHaveBeenCalledWith({ runId })
	current.status = 'in_progress'
	current.description = 'Revised request'
	expect(data((await step(context()))!.system!).tasks[0]).toMatchObject({
		status: 'in_progress',
		description: 'Revised request',
	})
	current.status = 'completed'
	expect(await step(context())).toBeUndefined()
})
it('orders active and failed tasks, counts unresolved dependencies, and caps the snapshot', async () => {
	const done = task({ status: 'completed' })
	const failed = task({ status: 'failed' })
	const active = task({
		status: 'in_progress',
		blockedBy: [done.id, failed.id, generateTaskId()],
		subject: '<instruction>'.repeat(100),
		description: 'detail'.repeat(100),
	})
	const step = createTaskContextStep(
		store(async () => [done, ...Array.from({ length: 40 }, () => task()), failed, active]),
		tenantId,
	)
	const result = await step(context())
	const snapshot = data(result!.system!)
	expect(snapshot.tasks[0]).toMatchObject({ id: active.id, unresolvedDependencies: 2 })
	expect(snapshot.tasks[1].status).toBe('failed')
	expect(snapshot.tasks.length).toBeLessThanOrEqual(8)
	expect(snapshot.omitted + snapshot.tasks.length).toBe(42)
	expect(result!.system!.length).toBeLessThanOrEqual(2415)
	expect(result!.system).not.toContain('<instruction>')
	expect((await step(context(850)))?.system?.length ?? 0).toBeLessThanOrEqual(865)
	expect(await step(context(699))).toBeUndefined()
})
it('bounds waiting without stacking reads or injecting late stale data', async () => {
	vi.useFakeTimers()
	let resolve!: (tasks: Task[]) => void
	const list = vi
		.fn<TaskStore['list']>()
		.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r
				}),
		)
		.mockResolvedValue([task({ subject: 'Fresh' })])
	const step = createTaskContextStep(store(list), tenantId)
	const rejected = expect(step(context())).rejects.toThrow('250ms')
	await vi.advanceTimersByTimeAsync(250)
	await rejected
	expect(await step(context())).toBeUndefined()
	expect(list).toHaveBeenCalledTimes(1)
	resolve([task({ subject: 'Stale' })])
	await vi.advanceTimersByTimeAsync(0)
	const next = await step(context())
	expect(next?.system).toContain('Fresh')
	expect(next?.system).not.toContain('Stale')
})
it('propagates cancellation and read failures', async () => {
	const controller = new AbortController()
	const step = createTaskContextStep(
		store(() => new Promise(() => {})),
		tenantId,
	)
	const rejected = expect(step({ ...context(), signal: controller.signal })).rejects.toThrow(
		'cancelled by user',
	)
	controller.abort(new Error('cancelled by user'))
	await rejected
	await expect(step({ ...context(), signal: controller.signal })).rejects.toThrow(
		'cancelled by user',
	)
	await expect(
		createTaskContextStep(
			store(async () => {
				throw new Error('disk unavailable')
			}),
			tenantId,
		)(context()),
	).rejects.toThrow('disk unavailable')
})
