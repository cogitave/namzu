import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { workflowHarness } from '../../workflows/__tests__/harness.js'
import { createIdleWatch, describeQuietTask } from '../idle-watch.js'

describe('the idle watch', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('trips once the silence reaches the bound and reports how long it was', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000_000)
		const watch = createIdleWatch({
			idleMs: 10_000,
			lastProgressAt: () => 1_000_000,
			pollMs: 1_000,
		})
		const abort = new AbortController()
		let tripped = false
		void watch.wait(abort.signal).then(() => {
			tripped = true
		})
		await vi.advanceTimersByTimeAsync(9_000)
		expect(tripped).toBe(false)
		expect(watch.quietForMs()).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(tripped).toBe(true)
		expect(watch.quietForMs()).toBe(10_000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('is reset by progress and never trips when progress cannot be read', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		let last: number | undefined = 0
		const watch = createIdleWatch({ idleMs: 5_000, lastProgressAt: () => last })
		let tripped = false
		void watch.wait(new AbortController().signal).then(() => {
			tripped = true
		})
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(4_000)
			last = Date.now()
		}
		expect(tripped).toBe(false)
		last = undefined
		await vi.advanceTimersByTimeAsync(60_000)
		expect(tripped).toBe(false)
	})

	it('stops its timer when the wait is aborted', async () => {
		vi.useFakeTimers()
		const abort = new AbortController()
		void createIdleWatch({ lastProgressAt: () => 0 }).wait(abort.signal)
		expect(vi.getTimerCount()).toBe(1)
		abort.abort()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('words a quiet task as quiet and not stopped', () => {
		expect(describeQuietTask('t1', 125_400, false)).toBe(
			'Task t1 is still running but went quiet: no activity from it for 125s. It has not been stopped and may still be working; its result will arrive as a task notification. agent_task_list shows what it did last.',
		)
		expect(describeQuietTask('t1', 1_000, true)).toContain('is still queued')
	})
})

describe('wait_for_task on an agent that has gone quiet', () => {
	const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
	afterEach(async () => {
		vi.useRealTimers()
		for (const h of open.splice(0)) {
			h.gate.open()
			await h.close()
			removeTempDir(h.cwd)
		}
	})

	it('returns "went quiet" after the idle bound, with the agent still running', async () => {
		const h = await workflowHarness({ held: true })
		open.push(h)
		await h.start({
			script: `export const meta = { name: 'quiet', description: 'one held agent', phases: [] }
return await agent('Return a greeting, no tools.', { label: 'held' })`,
		})
		await h.until(() => h.gate.waiting() === 1)
		const listed = JSON.parse((await h.runtime.agentTaskListTool.execute({}, h.context)).output)
		const taskId = listed.tasks[0].task_id as string

		vi.useFakeTimers()
		const waited = h.runtime.waitForTaskTool.execute({ task_id: taskId }, h.context)
		await vi.advanceTimersByTimeAsync(119_000)
		let settled = false
		void waited.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(10_000)
		const result = await waited
		expect(result.success).toBe(true)
		expect(result.output).toMatch(/went quiet: no activity from it for 1[23]\d+s/)
		expect(result.data).toMatchObject({ wait_released: 'idle', state: 'running' })
		expect(h.gate.waiting()).toBe(1)
	})
})
