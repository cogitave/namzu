import {
	type PrepareStepContext,
	type Task,
	type TaskStore,
	generateSessionId,
	generateTaskId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { createTaskContextStep } from './task-context.js'

const sessionId = generateSessionId()
const turnId = generateTurnId()
const earlierTurn = generateTurnId()
const tenantId = generateTenantId()
const context = (
	remainingTokens = 10000,
	overrides: Partial<PrepareStepContext> = {},
): PrepareStepContext => ({
	sessionId,
	turnId,
	stepNumber: 1,
	messages: [],
	steps: [],
	prepared: { system: 'Host guidance' },
	contextBudget: { remainingTokens, windowTokens: 100000 },
	...overrides,
})
const task = (overrides: Partial<Task> = {}): Task => ({
	id: generateTaskId(),
	sessionId,
	turnId,
	tenantId,
	subject: 'Inspect implementation',
	status: 'pending',
	blocks: [],
	blockedBy: [],
	createdAt: 1,
	...overrides,
})
const store = (list: TaskStore['list']) => ({ list }) as TaskStore
const data = (system: string) => JSON.parse(system.split('\n').at(-1) ?? '{}')
afterEach(() => vi.useRealTimers())

it('refreshes the session’s unfinished work without importing other scopes', async () => {
	const current = task()
	const list = vi.fn(async () => [
		current,
		task({ sessionId: generateSessionId(), subject: 'Other session secret' }),
		task({ tenantId: generateTenantId(), subject: 'Other tenant secret' }),
		task({ tenantId: undefined, subject: 'Unscoped secret' }),
	])
	const step = createTaskContextStep(store(list), tenantId)
	const first = await step(context())
	expect(first?.system).toContain('Host guidance')
	expect(first?.system).not.toContain('secret')
	expect(data(first?.system ?? '').tasks).toHaveLength(1)
	expect(list).toHaveBeenCalledWith({ sessionId })
	current.status = 'in_progress'
	current.description = 'Revised request'
	expect(data((await step(context()))?.system ?? '').tasks[0]).toMatchObject({
		status: 'in_progress',
		description: 'Revised request',
	})
	current.status = 'completed'
	current.completedAt = 0
	expect(await step(context())).toBeUndefined()
})

it('shows open tasks from earlier turns and tasks closed in this turn, not those closed before', async () => {
	let clock = 1_000
	const openFromEarlier = task({ turnId: earlierTurn, subject: 'Open from an earlier turn' })
	const closedEarlier = task({
		turnId: earlierTurn,
		status: 'completed',
		completedAt: 500,
		subject: 'Closed in an earlier turn',
	})
	const closedNow = task({ status: 'completed', subject: 'Closed in this turn' })
	const step = createTaskContextStep(
		store(async () => [openFromEarlier, closedEarlier, closedNow]),
		tenantId,
		() => clock,
	)
	await step(context())
	clock = 2_000
	closedNow.completedAt = 1_500

	const snapshot = data((await step(context()))?.system ?? '')

	expect(snapshot.tasks.map((row: { subject: string }) => row.subject)).toEqual([
		'Open from an earlier turn',
		'Closed in this turn',
	])
	expect(snapshot.unfinished).toBe(1)
})

it('keeps what a resumed turn closed before its pause, in whichever process resumes it', async () => {
	const open = task({ subject: 'Still open' })
	const closedBeforePause = task({
		status: 'completed',
		completedAt: 150,
		subject: 'Closed before the pause',
	})
	// A fresh step instance, as a process resuming the turn builds one: its
	// own clock is past the task's close, and the kernel's recorded start of
	// the turn is before it.
	const step = createTaskContextStep(
		store(async () => [open, closedBeforePause]),
		tenantId,
		() => 200,
	)
	const snapshot = data((await step(context(10000, { turnStartedAt: 100 })))?.system ?? '')
	expect(snapshot.tasks.map((row: { subject: string }) => row.subject)).toEqual([
		'Still open',
		'Closed before the pause',
	])
})

it('orders active and failed tasks, counts unresolved dependencies, and caps the snapshot', async () => {
	const done = task({ status: 'completed', completedAt: 0 })
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
		() => 1,
	)
	const result = await step(context())
	const snapshot = data(result?.system ?? '')
	expect(snapshot.tasks[0]).toMatchObject({ id: active.id, unresolvedDependencies: 2 })
	expect(snapshot.tasks[1].status).toBe('failed')
	expect(snapshot.tasks.length).toBeLessThanOrEqual(8)
	expect(snapshot.omitted + snapshot.tasks.length).toBe(42)
	expect(result?.system?.length).toBeLessThanOrEqual(2415)
	expect(result?.system).not.toContain('<instruction>')
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
