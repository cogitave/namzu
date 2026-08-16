import { describe, expect, it, vi } from 'vitest'

import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { TaskId } from '../../../types/ids/index.js'
import { describeWaitTimeout, waitForTaskWithBounds } from '../wait-with-idle-bound.js'

/**
 * A wall clock cannot tell a slow worker from a stuck one.
 *
 * The bound before this was an hour of elapsed time, and an hour has to do
 * two incompatible jobs: be long enough for a child doing real work, and
 * short enough to notice one that wedged. It cannot be both, so a worker
 * stuck in minute two held the supervisor for another fifty-eight, and one
 * making steady progress at minute fifty-nine was killed for being slow.
 *
 * These tests drive both clocks with a fake one, because the real bounds are
 * measured in minutes and a test that actually waits them out is a test
 * nobody runs.
 */

function gatewayFor(opts: {
	/** Resolve the wait when this is called. */
	settle?: (resolve: (h: TaskHandle) => void) => void
	withProgress?: boolean
}): { gateway: TaskScheduler; progress: () => void; finish: () => void } {
	let resolveWait: ((h: TaskHandle) => void) | undefined
	const listeners = new Set<(id: TaskId) => void>()

	const handle: TaskHandle = {
		taskId: 'tsk_1' as TaskId,
		agentId: 'worker',
		state: 'completed',
		createdAt: 0,
		completedAt: 1,
	}

	const gateway = {
		waitForTask: () =>
			new Promise<TaskHandle>((resolve) => {
				resolveWait = resolve
				opts.settle?.(resolve)
			}),
		...(opts.withProgress === false
			? {}
			: {
					onTaskProgress: (cb: (id: TaskId) => void) => {
						listeners.add(cb)
						return () => listeners.delete(cb)
					},
				}),
	} as unknown as TaskScheduler

	return {
		gateway,
		progress: () => {
			for (const cb of listeners) cb('tsk_1' as TaskId)
		},
		finish: () => resolveWait?.(handle),
	}
}

/** A clock the test moves by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
	let t = 1_000_000
	return {
		now: () => t,
		advance: (ms) => {
			t += ms
		},
	}
}

describe('a worker that is still working is not killed for being slow', () => {
	it('keeps waiting past the idle bound while progress keeps arriving', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { gateway, progress, finish } = gatewayFor({})

			const waiting = waitForTaskWithBounds(
				gateway,
				'tsk_1' as TaskId,
				{ runMs: 60_000, idleMs: 5_000 },
				clock.now,
			)

			// Four times the idle bound in elapsed time, but never quiet for
			// more than half of it.
			for (let i = 0; i < 8; i += 1) {
				clock.advance(2_500)
				progress()
				await vi.advanceTimersByTimeAsync(1_000)
			}

			finish()
			await vi.advanceTimersByTimeAsync(1_000)

			expect((await waiting).kind, 'a working worker was cut off').toBe('completed')
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('a worker that has gone quiet is reported as quiet', () => {
	it('fires the idle bound and says which clock it was', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { gateway } = gatewayFor({})

			const waiting = waitForTaskWithBounds(
				gateway,
				'tsk_1' as TaskId,
				{ runMs: 600_000, idleMs: 5_000 },
				clock.now,
			)

			clock.advance(6_000)
			await vi.advanceTimersByTimeAsync(1_100)

			const outcome = await waiting
			expect(outcome.kind).toBe('timeout')
			if (outcome.kind !== 'timeout') return
			// The distinction is the point: "went quiet" and "ran too long"
			// are different diagnoses and the caller acts on the message.
			expect(outcome.cause).toBe('idle')
			expect(outcome.idleBoundArmed).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it('says it went quiet, and that the worker was not cancelled', () => {
		const text = describeWaitTimeout({
			kind: 'timeout',
			cause: 'idle',
			elapsedMs: 30_000,
			idleBoundArmed: true,
		})

		expect(text).toContain('went quiet')
		// A wait that ran out is a statement about the WAITER. Losing an
		// eight-minute worker's output because a short clock expired is the
		// bug this whole area has been unpicking.
		expect(text).toContain('not been cancelled')
	})
})

describe('the run bound still catches a worker that never stops', () => {
	it('fires on elapsed time even while progress keeps arriving', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { gateway, progress } = gatewayFor({})

			const waiting = waitForTaskWithBounds(
				gateway,
				'tsk_1' as TaskId,
				{ runMs: 10_000, idleMs: 5_000 },
				clock.now,
			)

			for (let i = 0; i < 6; i += 1) {
				clock.advance(2_000)
				progress()
				await vi.advanceTimersByTimeAsync(1_000)
			}

			const outcome = await waiting
			expect(outcome.kind).toBe('timeout')
			if (outcome.kind !== 'timeout') return
			expect(outcome.cause).toBe('run')
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('a gateway that cannot see its children', () => {
	it('is bounded by the wall clock alone, as it was before', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { gateway } = gatewayFor({ withProgress: false })

			const waiting = waitForTaskWithBounds(
				gateway,
				'tsk_1' as TaskId,
				{ runMs: 10_000, idleMs: 1_000 },
				clock.now,
			)

			// Far past the idle bound, and it must NOT fire — there is no
			// signal, so silence carries no information.
			clock.advance(5_000)
			await vi.advanceTimersByTimeAsync(1_100)
			clock.advance(6_000)
			await vi.advanceTimersByTimeAsync(1_100)

			const outcome = await waiting
			expect(outcome.kind).toBe('timeout')
			if (outcome.kind !== 'timeout') return
			expect(outcome.cause).toBe('run')
			// And the degradation is visible rather than silent.
			expect(outcome.idleBoundArmed).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('says so, instead of implying the worker was stuck', () => {
		const text = describeWaitTimeout({
			kind: 'timeout',
			cause: 'run',
			elapsedMs: 3_600_000,
			idleBoundArmed: false,
		})

		expect(text).toContain('cannot report progress')
	})
})

describe('a completion always wins', () => {
	it('returns the handle rather than a timeout when the task finishes first', async () => {
		vi.useFakeTimers()
		try {
			const clock = fakeClock()
			const { gateway, finish } = gatewayFor({})

			const waiting = waitForTaskWithBounds(
				gateway,
				'tsk_1' as TaskId,
				{ runMs: 10_000, idleMs: 5_000 },
				clock.now,
			)

			finish()
			await vi.advanceTimersByTimeAsync(10)

			const outcome = await waiting
			expect(outcome.kind).toBe('completed')
		} finally {
			vi.useRealTimers()
		}
	})
})
