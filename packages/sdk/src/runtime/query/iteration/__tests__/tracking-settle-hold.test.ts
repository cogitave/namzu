import { afterEach, describe, expect, it, vi } from 'vitest'

import { CompletionInbox } from '../../../../scheduler/completion-inbox.js'
import type { TaskHandle, TaskScheduler } from '../../../../types/agent/scheduler.js'
import type { TaskId } from '../../../../types/ids/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { GuardCoordinator } from '../../guard.js'
import { holdForOutstandingWork, settleGraceMs } from '../outstanding-work.js'
import type { IterationContext } from '../phases/index.js'

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
function fixture() {
	const tracking = deferred()
	const inbox = new CompletionInbox()
	let announce!: (handle: TaskHandle) => void
	inbox.attach({
		onTaskCompleted: (callback: typeof announce) => {
			announce = callback
			return () => {}
		},
		getTask: () => undefined,
	} as unknown as TaskScheduler)
	inbox.expect('owned' as TaskId)
	inbox.deferDelivery('owned' as TaskId, tracking.promise)
	const messages: unknown[] = []
	const ctx = {
		completionInbox: inbox,
		guard: new GuardCoordinator({ tokenBudget: 100_000, timeoutMs: 20_000 }),
		abortController: new AbortController(),
		log: NOOP_LOGGER,
		recorder: {
			turnId: 'turn',
			pushMessage: (message: unknown) => {
				messages.push(message)
			},
		},
		emitEvent: async () => {},
		drainPending: function* () {},
	} as unknown as IterationContext
	return {
		ctx,
		inbox,
		tracking,
		messages,
		finish: () =>
			announce({
				taskId: 'owned' as TaskId,
				agentId: 'worker',
				state: 'completed',
				createdAt: 1,
				completedAt: 2,
			}),
	}
}
async function outcome(iterator: AsyncGenerator<unknown, boolean>) {
	for (;;) {
		const next = await iterator.next()
		if (next.done) return next.value
	}
}
afterEach(() => {
	vi.useRealTimers()
})

describe('tracking does not extend the outstanding-work settle hold', () => {
	it('ends at its own grace when a finished worker tracking write is still pending', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const grace = settleGraceMs(f.ctx.guard.remainingBeforeFinalizeMs())
		const returned = vi.fn()
		const held = outcome(holdForOutstandingWork(f.ctx, 1, false, () => 0)).then((value) => {
			returned(value)
			return value
		})
		f.finish()
		await vi.advanceTimersByTimeAsync(1)
		expect(returned).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(grace - 1)
		expect(await held).toBe(false)
		expect(f.messages).toEqual([])
		expect(f.inbox.hasPendingWork).toBe(true)
		f.tracking.resolve()
		expect(await f.inbox.drainAsync()).toHaveLength(1)
	})

	it('delivers the exact completion if its tracking settles later within the hold', async () => {
		vi.useFakeTimers()
		const f = fixture()
		const returned = vi.fn()
		const held = outcome(holdForOutstandingWork(f.ctx, 1, false, () => 0)).then((value) => {
			returned(value)
			return value
		})
		f.finish()
		await vi.advanceTimersByTimeAsync(10)
		expect(returned).not.toHaveBeenCalled()
		f.tracking.resolve()
		expect(await held).toBe(true)
		expect(f.messages).toHaveLength(1)
		expect(f.inbox.hasPendingWork).toBe(false)
	})

	it('delivers inbound steering without waiting again on arrived tracking', async () => {
		const f = fixture()
		const inbound = deferred()
		let ready = false
		const ctx = { ...f.ctx, waitForInbound: () => inbound.promise }
		const held = outcome(holdForOutstandingWork(ctx, 1, false, () => (ready ? 1 : 0)))
		f.finish()
		ready = true
		inbound.resolve()
		expect(await held).toBe(true)
		expect(f.messages).toEqual([])
		expect(f.inbox.hasPendingWork).toBe(true)
		f.tracking.resolve()
		expect(await f.inbox.drainAsync()).toHaveLength(1)
	})
})
