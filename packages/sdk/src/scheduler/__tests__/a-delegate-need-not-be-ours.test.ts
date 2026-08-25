import { describe, expect, it } from 'vitest'

import { taskFailed, taskSucceeded } from '../../tools/coordinator/outcome.js'
import type { Delegate, DelegateResult } from '../../types/agent/delegate.js'
import type { CreateTaskOptions, TaskHandle, TaskScheduler } from '../../types/agent/scheduler.js'
import type { TaskId } from '../../types/ids/index.js'
import { type CancelCause, cancelCauseOf } from '../../types/run/cancel-cause.js'
import {
	DelegateCapabilityError,
	DelegateCapabilityMismatchError,
	DelegateIdCollisionError,
	DelegatingTaskScheduler,
	NoDelegateError,
} from '../delegating.js'

/**
 * A delegate that is not one of ours.
 *
 * Delegation was reachable exactly one way — an `agentId` the host's
 * `AgentManager` could resolve — so every delegate was a Namzu agent in
 * this process. These pin the seam that removes that assumption without
 * changing anything the delegation tools do, and in particular that
 * `taskSucceeded` / `taskFailed` keep giving the right answers about a
 * worker this kernel never ran.
 */

const request = (agentId: string): CreateTaskOptions => ({
	agentId,
	prompt: 'do the thing',
	workingDirectory: '/tmp/x',
})

function delegate(
	id: string,
	result: DelegateResult | (() => Promise<DelegateResult>),
	over: Partial<Delegate> = {},
): Delegate {
	return {
		id,
		capabilities: { cancel: true, continue: false },
		dispatch: typeof result === 'function' ? () => result() : async () => result,
		...over,
	}
}

/** A local scheduler that records what reached it, and nothing more. */
class RecordingLocal implements TaskScheduler {
	readonly seen: string[] = []

	async createTask(options: CreateTaskOptions): Promise<TaskHandle> {
		this.seen.push(options.agentId)
		return {
			taskId: 'tsk_local' as TaskId,
			agentId: options.agentId,
			state: 'completed',
			createdAt: Date.now(),
		}
	}
	async waitForTask(taskId: TaskId): Promise<TaskHandle> {
		this.seen.push(`wait:${taskId}`)
		return { taskId, agentId: 'local', state: 'completed', createdAt: Date.now() }
	}
	async continueTask(taskId: TaskId): Promise<void> {
		this.seen.push(`continue:${taskId}`)
	}
	cancelTask(taskId: TaskId, cause?: CancelCause): void {
		this.seen.push(`cancel:${taskId}:${cause ?? 'none'}`)
	}
	getTask(): TaskHandle | undefined {
		return undefined
	}
	listTasks(): TaskHandle[] {
		return []
	}
	onTaskCompleted(): () => void {
		return () => {}
	}
}

describe('a foreign delegate answers through the scheduler the tools already speak', () => {
	it('dispatches to the delegate and settles the handle', async () => {
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed', output: 'the answer' })],
		})

		const handle = await scheduler.createTask(request('remote'))
		const settled = await scheduler.waitForTask(handle.taskId)

		expect(settled.result?.result).toBe('the answer')
	})

	it('reads as succeeded to the predicate the tools use', async () => {
		// The whole point of the mapping. `taskSucceeded` requires the gateway
		// state and the run status to AGREE, because locally they are two
		// authorities — a foreign delegate has one word, written onto both.
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed', output: 'ok' })],
		})

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(request('remote'))).taskId,
		)

		expect(taskSucceeded(settled)).toBe(true)
		expect(taskFailed(settled)).toBe(false)
	})

	it('reads as failed, carrying the delegate’s own words', async () => {
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'failed', error: 'the peer refused' })],
		})

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(request('remote'))).taskId,
		)

		expect(taskSucceeded(settled)).toBe(false)
		expect(taskFailed(settled)).toBe(true)
		expect(settled.result?.lastError).toBe('the peer refused')
	})

	it('does NOT read a cancellation as a failure', async () => {
		// `SiblingFailurePolicy: 'cancel-siblings'` acts on `taskFailed`, so
		// calling a deliberate stop a failure tears down every healthy
		// sibling as a consequence of the stop.
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'cancelled' })],
		})

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(request('remote'))).taskId,
		)

		expect(settled.state).toBe('canceled')
		expect(taskFailed(settled)).toBe(false)
		expect(taskSucceeded(settled)).toBe(false)
	})

	it('writes the SAME answer onto both authorities, for each of the three outcomes', async () => {
		// `state` and `result.status` are checked by different predicates —
		// `taskSucceeded` reads state first, `taskFailed` reads either — so a
		// wrong `status` hides behind a right `state`. Both are pinned, and
		// the spellings differ on purpose: AgentTaskState says 'canceled',
		// RunExecutionStatus says 'cancelled'.
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				delegate('ok', { status: 'completed' }),
				delegate('bad', { status: 'failed' }),
				delegate('stopped', { status: 'cancelled' }),
			],
		})

		const settle = async (id: string) =>
			await scheduler.waitForTask((await scheduler.createTask(request(id))).taskId)

		expect(await settle('ok')).toMatchObject({
			state: 'completed',
			result: { status: 'completed' },
		})
		expect(await settle('bad')).toMatchObject({ state: 'failed', result: { status: 'failed' } })
		expect(await settle('stopped')).toMatchObject({
			state: 'canceled',
			result: { status: 'cancelled' },
		})
	})

	it('forwards the parent’s environment to the delegate', async () => {
		// The reason the `Agent` tool forwards it to a local child: a delegate
		// that cannot see it runs against different services than the run that
		// launched it, silently.
		let seen: Readonly<Record<string, string>> | undefined
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				{
					id: 'remote',
					capabilities: { cancel: true, continue: false },
					dispatch: async (req) => {
						seen = req.env
						return { status: 'completed' }
					},
				},
			],
		})

		await scheduler.waitForTask(
			(
				await scheduler.createTask({
					...request('remote'),
					configOverrides: { env: { API_BASE: 'https://staging.example' } },
				})
			).taskId,
		)

		expect(seen).toEqual({ API_BASE: 'https://staging.example' })
	})

	it('settles a delegate that threw rather than leaving the wait hanging', async () => {
		// A throw is a failure, not a disappearance. Left `running`, the
		// parent's `waitForTask` never returns on a delegation already over.
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				delegate('remote', async () => {
					throw new Error('connection reset')
				}),
			],
		})

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(request('remote'))).taskId,
		)

		expect(taskFailed(settled)).toBe(true)
		expect(settled.result?.lastError).toBe('connection reset')
	})

	it('reports zero cost with no rate card, rather than a rate of zero', async () => {
		// This kernel did not spend the delegate's tokens and cannot learn
		// what it spent. A rate of zero would read as "the model is free".
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed', output: 'x' })],
		})

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(request('remote'))).taskId,
		)

		expect(settled.result?.cost.totalCost).toBe(0)
		expect(settled.result?.cost.inputCostPer1M).toBeUndefined()
	})
})

describe('an id no delegate claims goes to the local scheduler', () => {
	it('passes it through untouched', async () => {
		const local = new RecordingLocal()
		const scheduler = new DelegatingTaskScheduler({
			local,
			delegates: [delegate('remote', { status: 'completed' })],
		})

		await scheduler.createTask(request('a-local-agent'))

		expect(local.seen).toEqual(['a-local-agent'])
	})

	it('does not send a claimed id to the local scheduler', async () => {
		const local = new RecordingLocal()
		const scheduler = new DelegatingTaskScheduler({
			local,
			delegates: [delegate('remote', { status: 'completed' })],
		})

		await scheduler.createTask(request('remote'))

		expect(local.seen).toEqual([])
	})

	it('refuses when there is no local scheduler to fall through to', async () => {
		// A real configuration — a host that delegates only to foreign peers
		// — where an unknown id is a caller error rather than something to
		// pass along to nobody.
		const scheduler = new DelegatingTaskScheduler({ delegates: [] })

		await expect(scheduler.createTask(request('nobody'))).rejects.toThrow(NoDelegateError)
	})

	it('lists both its own tasks and the local ones', async () => {
		// A supervisor listing its children should not have to know which of
		// them happen to be foreign.
		const local = new RecordingLocal()
		local.listTasks = () => [
			{ taskId: 'tsk_l' as TaskId, agentId: 'local', state: 'running', createdAt: 0 },
		]
		const scheduler = new DelegatingTaskScheduler({
			local,
			delegates: [delegate('remote', { status: 'completed' })],
		})
		await scheduler.createTask(request('remote'))

		expect(
			scheduler
				.listTasks()
				.map((t) => t.agentId)
				.sort(),
		).toEqual(['local', 'remote'])
	})

	it('forwards a structured cause when cancelling a local task', async () => {
		const local = new RecordingLocal()
		const scheduler = new DelegatingTaskScheduler({
			local,
			delegates: [delegate('remote', { status: 'completed' })],
		})
		const handle = await scheduler.createTask(request('a-local-agent'))

		scheduler.cancelTask(handle.taskId, 'parent')

		expect(local.seen).toEqual(['a-local-agent', `cancel:${handle.taskId}:parent`])
	})
})

describe('a capability a delegate does not have is refused, not dropped', () => {
	it('refuses continue on a delegate that cannot continue', async () => {
		// A no-op has the parent believe it steered a worker that never heard
		// it, and go on believing that until the answer comes back unchanged.
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				delegate('remote', async () => new Promise(() => ({ status: 'completed' }) as never)),
			],
		})
		const handle = await scheduler.createTask(request('remote'))

		await expect(scheduler.continueTask(handle.taskId, 'also do X')).rejects.toThrow(
			DelegateCapabilityError,
		)
	})

	it('delivers continue on a delegate that can', async () => {
		const heard: string[] = []
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				delegate('remote', async () => new Promise(() => ({ status: 'completed' }) as never), {
					capabilities: { cancel: true, continue: true },
					continue: async (message: string) => {
						heard.push(message)
					},
				}),
			],
		})
		const handle = await scheduler.createTask(request('remote'))

		await scheduler.continueTask(handle.taskId, 'also do X')

		expect(heard).toEqual(['also do X'])
	})

	it('refuses a capability claim the object does not back, at registration', async () => {
		// At registration, not at the call: a capability that claims a method
		// the object does not have is a lie the caller would otherwise find
		// mid-delegation, with a worker running.
		expect(
			() =>
				new DelegatingTaskScheduler({
					delegates: [
						delegate(
							'remote',
							{ status: 'completed' },
							{
								capabilities: { cancel: true, continue: true },
							},
						),
					],
				}),
		).toThrow(DelegateCapabilityMismatchError)
	})

	it('refuses cancel on a delegate that cannot be cancelled', async () => {
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				delegate('remote', async () => new Promise(() => ({ status: 'completed' }) as never), {
					capabilities: { cancel: false, continue: false },
				}),
			],
		})
		const handle = await scheduler.createTask(request('remote'))

		expect(() => scheduler.cancelTask(handle.taskId)).toThrow(DelegateCapabilityError)
	})

	it('aborts the signal the delegate was handed', async () => {
		let seen: AbortSignal | undefined
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				{
					id: 'remote',
					capabilities: { cancel: true, continue: false },
					dispatch: async (_request, opts) => {
						seen = opts.signal
						return await new Promise<DelegateResult>((resolve) => {
							opts.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }))
						})
					},
				},
			],
		})
		const handle = await scheduler.createTask(request('remote'))

		scheduler.cancelTask(handle.taskId)
		const settled = await scheduler.waitForTask(handle.taskId)

		expect(seen?.aborted).toBe(true)
		// The DELEGATE's answer decides the state, not the cancel call. A
		// delegate that finished a microsecond before the abort would
		// otherwise be recorded as cancelled with its answer left unread.
		expect(settled.state).toBe('canceled')
	})

	it('preserves a structured parent cause on the foreign delegate signal', async () => {
		let seen: AbortSignal | undefined
		const scheduler = new DelegatingTaskScheduler({
			delegates: [
				{
					id: 'remote',
					capabilities: { cancel: true, continue: false },
					dispatch: async (_request, opts) => {
						seen = opts.signal
						return await new Promise<DelegateResult>((resolve) => {
							opts.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }))
						})
					},
				},
			],
		})
		const handle = await scheduler.createTask(request('remote'))

		scheduler.cancelTask(handle.taskId, 'parent')
		await scheduler.waitForTask(handle.taskId)

		expect(cancelCauseOf(seen?.reason)).toBe('parent')
	})

	it('lets a delegate that finished first keep its answer', async () => {
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed', output: 'already done' })],
		})
		const handle = await scheduler.createTask(request('remote'))
		await scheduler.waitForTask(handle.taskId)

		scheduler.cancelTask(handle.taskId)
		const settled = await scheduler.waitForTask(handle.taskId)

		expect(settled.state).toBe('completed')
		expect(settled.result?.result).toBe('already done')
	})
})

describe('two delegates cannot claim one id', () => {
	it('refuses at construction rather than resolving by order', async () => {
		// A precedence rule makes which delegate answers depend on
		// registration order, which is not visible at the call site that gets
		// the wrong one.
		expect(
			() =>
				new DelegatingTaskScheduler({
					delegates: [
						delegate('remote', { status: 'completed' }),
						delegate('remote', { status: 'failed' }),
					],
				}),
		).toThrow(DelegateIdCollisionError)
	})
})

describe('completion is announced', () => {
	it('tells a listener when a foreign delegation settles', async () => {
		const seen: TaskHandle[] = []
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed', output: 'x' })],
		})
		scheduler.onTaskCompleted((handle) => seen.push(handle))

		const handle = await scheduler.createTask(request('remote'))
		await scheduler.waitForTask(handle.taskId)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.state).toBe('completed')
	})

	it('stops telling it after unsubscribe', async () => {
		const seen: TaskHandle[] = []
		const scheduler = new DelegatingTaskScheduler({
			delegates: [delegate('remote', { status: 'completed' })],
		})
		const off = scheduler.onTaskCompleted((handle) => seen.push(handle))
		off()

		await scheduler.waitForTask((await scheduler.createTask(request('remote'))).taskId)

		expect(seen).toHaveLength(0)
	})
})
