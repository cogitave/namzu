import { describe, expect, it, vi } from 'vitest'

import type { TaskGateway, TaskHandle } from '../../types/agent/gateway.js'
import type { TaskId } from '../../types/ids/index.js'
import { CompletionInbox, formatCompletionNotification } from '../completion-inbox.js'

/**
 * Who tells the supervisor a worker finished.
 *
 * Normally the `create_task` call does: it blocks, and the worker's output
 * comes back as that call's `tool_result`. Two cases have no such call — a
 * launch made in the background, and a blocking launch whose deadline passed
 * while the worker kept going — and until this existed the result of those
 * simply vanished. The gateway still held it; nothing ever read it.
 *
 * An earlier version of this channel was removed in `dc16d58` because it
 * fired for completions the blocking tool had ALREADY delivered, so the
 * supervisor saw every result twice: once as a `tool_result`, once as an
 * orphan envelope. That removal is the reason the tests below care as much
 * about what does NOT get delivered as about what does.
 */

function handleFor(taskId: string, result?: string): TaskHandle {
	return {
		taskId: taskId as TaskId,
		agentId: 'reviewer',
		state: 'completed',
		createdAt: 1_000,
		completedAt: 3_500,
		...(result !== undefined
			? { result: { status: 'completed', result } as TaskHandle['result'] }
			: {}),
	}
}

/** A gateway that only does the one thing the inbox uses. */
function fakeGateway(): {
	gateway: TaskGateway
	settle: (h: TaskHandle) => void
	listeners: number
} {
	const listeners = new Set<(h: TaskHandle) => void>()
	const gateway = {
		onTaskCompleted(cb: (h: TaskHandle) => void) {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
	} as unknown as TaskGateway
	return {
		gateway,
		settle: (h) => {
			for (const cb of listeners) cb(h)
		},
		get listeners() {
			return listeners.size
		},
	}
}

describe('a completion nobody waited for reaches the transcript', () => {
	it('queues a settled task and hands it over once', () => {
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		settle(handleFor('tsk_1', 'the report'))

		expect(inbox.hasUnheard).toBe(true)
		expect(inbox.drain().map((h) => h.taskId)).toEqual(['tsk_1'])
		// Drained, not peeked: a notification that survives its own delivery
		// is the duplicate bug wearing a different hat.
		expect(inbox.drain()).toEqual([])
		expect(inbox.hasUnheard).toBe(false)
	})

	it('queues nothing at all when no task settles', () => {
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		expect(inbox.hasUnheard).toBe(false)
		expect(inbox.drain()).toEqual([])
	})
})

describe('a completion the tool already delivered is never delivered twice', () => {
	it('drops a claimed completion', () => {
		// The `dc16d58` regression, pinned. `create_task` blocked, got the
		// result, and returned it as its own tool_result — so the envelope
		// must not also carry it.
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		settle(handleFor('tsk_1', 'the report'))
		inbox.claim('tsk_1' as TaskId)

		expect(inbox.hasUnheard).toBe(false)
		expect(inbox.drain()).toEqual([])
	})

	it('drops it even when the claim beats the announcement', () => {
		// Ordering is not guaranteed: the tool's own `waitForTask` can resolve
		// before the gateway's completion listener runs. A claim that only
		// worked after the announcement would leak a duplicate exactly in the
		// races that are hardest to reproduce.
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		inbox.claim('tsk_1' as TaskId)
		settle(handleFor('tsk_1', 'the report'))

		expect(inbox.drain()).toEqual([])
	})

	it('still delivers the sibling that nobody claimed', () => {
		// The mixed turn: one worker awaited to completion, one abandoned.
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		settle(handleFor('tsk_awaited', 'delivered inline'))
		settle(handleFor('tsk_abandoned', 'nobody heard this'))
		inbox.claim('tsk_awaited' as TaskId)

		expect(inbox.drain().map((h) => h.taskId)).toEqual(['tsk_abandoned'])
	})

	it('subscribes once no matter how often it is attached', () => {
		// Two subscriptions would queue every completion twice and reproduce
		// the duplicate delivery from the inside.
		const { gateway, settle, ...rest } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.attach(gateway)

		settle(handleFor('tsk_1', 'once'))

		expect(inbox.drain()).toHaveLength(1)
		void rest
	})

	it('stops listening when closed', () => {
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.close()

		settle(handleFor('tsk_1', 'too late'))

		expect(inbox.drain()).toEqual([])
	})
})

describe('a launch nobody is waiting for holds the run open', () => {
	it('counts an expected task as pending work before it settles', () => {
		// Without this the run settles while a background worker is still
		// going and discards the result the launch existed to produce.
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		expect(inbox.hasPendingWork).toBe(false)
		inbox.expect('tsk_1' as TaskId)
		expect(inbox.hasPendingWork).toBe(true)
	})

	it('stops counting it once it settles', () => {
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_1' as TaskId)

		settle(handleFor('tsk_1', 'done'))

		// Still pending — as an UNHEARD completion now rather than an
		// outstanding one, which is what the loop drains.
		expect(inbox.hasPendingWork).toBe(true)
		inbox.drain()
		expect(inbox.hasPendingWork).toBe(false)
	})

	it('ignores a task already delivered inline', () => {
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		inbox.claim('tsk_1' as TaskId)
		inbox.expect('tsk_1' as TaskId)

		expect(inbox.hasPendingWork).toBe(false)
	})

	it('keeps a result that already arrived, even when the task is cancelled', () => {
		// The window: a worker finishes, its completion is queued for the next
		// drain, and the model — told nothing yet, and reading a tool that says
		// it cancels a RUNNING task — cancels it. Clearing the queue here threw
		// away work that was done and output that existed nowhere else.
		//
		// `forget` is about pending work. A finished result is not pending work.
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_1' as TaskId)

		settle(handleFor('tsk_1', 'the worker finished before the cancel landed'))
		inbox.forget('tsk_1' as TaskId)

		const drained = inbox.drain()
		expect(
			drained.map((h) => h.taskId),
			'the finished result was discarded',
		).toEqual(['tsk_1'])
		expect(drained[0]?.result?.result).toBe('the worker finished before the cancel landed')
	})

	it('stops expecting a task that was cancelled', () => {
		// `expect` is only cleared by a COMPLETION, so a cancelled worker used
		// to keep the run open for the whole grace period, every time it tried
		// to settle, waiting for a result that had been called off.
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_1' as TaskId)

		inbox.forget('tsk_1' as TaskId)

		expect(inbox.hasPendingWork).toBe(false)
	})

	it('waits for an arrival and returns as soon as one lands', async () => {
		const { gateway, settle } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_1' as TaskId)

		const waited = inbox.waitForArrival(5_000)
		settle(handleFor('tsk_1', 'done'))
		await waited

		expect(inbox.drain().map((h) => h.taskId)).toEqual(['tsk_1'])
	})

	it('does not wait at all when there is nothing outstanding', async () => {
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)

		// A deadline this long would hang the suite if it were honoured.
		await inbox.waitForArrival(600_000)
	})

	it('gives up at the deadline rather than holding a run forever', async () => {
		// The bound is the point: a worker that never finishes must not keep
		// the run open indefinitely.
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_never' as TaskId)

		await inbox.waitForArrival(10)

		expect(inbox.hasPendingWork).toBe(true)
	})

	it('releases a waiter when the inbox closes', async () => {
		const { gateway } = fakeGateway()
		const inbox = new CompletionInbox()
		inbox.attach(gateway)
		inbox.expect('tsk_1' as TaskId)

		const waited = inbox.waitForArrival(600_000)
		inbox.close()
		await waited
	})
})

describe('the notification says which task and what it produced', () => {
	it('carries the id, the agent, the state and the output', () => {
		// All four matter. Without the id the supervisor cannot say which of
		// five workers this was; without the output it has to make the extra
		// call this mechanism exists to remove.
		const text = formatCompletionNotification([handleFor('tsk_42', 'the findings')])

		expect(text).toContain('task_id: tsk_42')
		expect(text).toContain('agent: reviewer')
		expect(text).toContain('state: completed')
		expect(text).toContain('duration_ms: 2500')
		expect(text).toContain('the findings')
	})

	it('names the tool that fetches the rest when it truncates', () => {
		const text = formatCompletionNotification([handleFor('tsk_42', 'x'.repeat(10_000))])

		expect(text).toContain('truncated')
		// The id is repeated in the truncation notice, so the follow-up call
		// does not require scrolling back up through 4 kB of output.
		expect(text).toContain('wait_for_task with task_id "tsk_42"')
		expect(text.length).toBeLessThan(4_500)
	})

	it('says so rather than going blank when a task produced nothing', () => {
		const text = formatCompletionNotification([handleFor('tsk_42')])

		expect(text).toContain('task_id: tsk_42')
		expect(text).toContain('produced no output')
	})

	it('groups a batch into one message', () => {
		const text = formatCompletionNotification([
			handleFor('tsk_1', 'first'),
			handleFor('tsk_2', 'second'),
		])

		expect(text).toContain('2 tasks')
		expect(text).toContain('tsk_1')
		expect(text).toContain('tsk_2')
	})

	it('explains why it is arriving here and not as a tool result', () => {
		// Otherwise the model has to guess whether it missed a call, and the
		// guess it makes is to go looking — which is the polling loop again.
		const text = formatCompletionNotification([handleFor('tsk_1', 'done')])

		expect(text).toContain('not waiting on it')
	})
})

describe('the inbox does not require anything of a host gateway', () => {
	it('uses only onTaskCompleted', () => {
		// The whole point of attaching through the existing subscription: a
		// host that implements TaskGateway keeps working untouched, and one
		// that was already firing completions into an empty listener set now
		// has a listener.
		const onTaskCompleted = vi.fn(() => () => {})
		const inbox = new CompletionInbox()

		inbox.attach({ onTaskCompleted } as unknown as TaskGateway)

		expect(onTaskCompleted).toHaveBeenCalledTimes(1)
	})
})
