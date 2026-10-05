import { describe, expect, it } from 'vitest'

import type { TaskHandle, TaskScheduler } from '../../types/agent/scheduler.js'
import type { TaskId } from '../../types/ids/index.js'
import { CompletionInbox } from '../completion-inbox.js'

function deferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function fixture() {
	const listeners = new Set<(handle: TaskHandle) => void>()
	const gateway = {
		onTaskCompleted: (callback: (handle: TaskHandle) => void) => {
			listeners.add(callback)
			return () => {
				listeners.delete(callback)
			}
		},
		getTask: () => undefined,
	} as unknown as TaskScheduler
	const inbox = new CompletionInbox()
	inbox.attach(gateway)
	return {
		inbox,
		gateway,
		complete: (id: string) => {
			const handle: TaskHandle = {
				taskId: id as TaskId,
				agentId: 'worker',
				state: 'completed',
				createdAt: 1,
				completedAt: 2,
			}
			for (const listener of listeners) listener(handle)
			return handle
		},
	}
}

describe('owned completion delivery settlement', () => {
	it('requires exact owned undelivered identity and refuses a second gate', () => {
		const { inbox } = fixture()
		expect(() => inbox.deferDelivery('foreign' as TaskId, Promise.resolve())).toThrow('owned')
		inbox.launched('own' as TaskId)
		inbox.deferDelivery('own' as TaskId, Promise.resolve())
		expect(() => inbox.deferDelivery('own' as TaskId, Promise.resolve())).toThrow('already')
		inbox.claim('own' as TaskId)
		expect(() => inbox.deferDelivery('own' as TaskId, Promise.resolve())).toThrow('undelivered')
	})

	it('recovers early completion but waits for tracking and delivers exactly once across concurrent drains', async () => {
		const f = fixture()
		const handle = f.complete('own')
		f.inbox.launched(handle.taskId)
		const tracking = deferred()
		f.inbox.deferDelivery(handle.taskId, tracking.promise)
		expect(f.inbox.drain()).toEqual([])
		expect(f.inbox.hasUnheard).toBe(false)
		expect(f.inbox.hasPendingWork).toBe(true)
		const first = f.inbox.drainAsync()
		const second = f.inbox.drainAsync()
		tracking.resolve()
		expect((await Promise.all([first, second])).flat()).toEqual([handle])
		f.complete('own')
		expect(f.inbox.drain()).toEqual([])
		expect(f.inbox.hasPendingWork).toBe(false)
	})

	it('does not wait on running workers or consume foreign completion results', async () => {
		const f = fixture()
		f.inbox.expect('running' as TaskId)
		f.inbox.deferDelivery('running' as TaskId, new Promise(() => {}))
		const other = new CompletionInbox()
		other.attach(f.gateway)
		f.complete('foreign')
		expect(await f.inbox.drainAsync()).toEqual([])
		expect(f.inbox.hasPendingWork).toBe(true)
		expect(await other.drainAsync()).toEqual([])
		f.inbox.launched('ready' as TaskId)
		const ready = f.complete('ready')
		expect(await f.inbox.drainAsync()).toEqual([ready])
	})

	it('wakes on persistence settlement and abort releases only an arrival waiter', async () => {
		const f = fixture()
		f.inbox.expect('own' as TaskId)
		const tracking = deferred()
		f.inbox.deferDelivery('own' as TaskId, tracking.promise)
		f.complete('own')
		const caller = new AbortController()
		const abandoned = f.inbox.waitForArrival(60_000, caller.signal)
		caller.abort()
		await abandoned
		expect(f.inbox.hasPendingWork).toBe(true)
		const arrived = f.inbox.waitForArrival(60_000)
		tracking.resolve()
		await arrived
		expect(f.inbox.hasUnheard).toBe(true)
		expect(f.inbox.drain()).toHaveLength(1)
	})

	it('retains all results when one tracking write fails, including the failure reason', async () => {
		const f = fixture()
		f.inbox.launched('failed' as TaskId)
		f.inbox.launched('ready' as TaskId)
		const tracking = deferred()
		f.inbox.deferDelivery('failed' as TaskId, tracking.promise)
		f.complete('ready')
		f.complete('failed')
		const pending = f.inbox.drainAsync()
		const failure = new Error('Tracking did not persist')
		tracking.reject(failure)
		await expect(pending).rejects.toBe(failure)
		expect(() => f.inbox.drain()).toThrow(failure)
		expect(f.inbox.hasPendingWork).toBe(true)
		// An authoritative inline reader may claim one exact result; neither
		// the failed drain nor its rejection claimed the unrelated ready one.
		f.inbox.claim('failed' as TaskId)
		expect(f.inbox.drain().map((handle) => handle.taskId)).toEqual(['ready'])
	})

	it('abort releases an actual pending drain without delivering or losing its completion', async () => {
		const f = fixture()
		f.inbox.launched('own' as TaskId)
		const tracking = deferred()
		f.inbox.deferDelivery('own' as TaskId, tracking.promise)
		const handle = f.complete('own')
		const caller = new AbortController()
		const draining = f.inbox.drainAsync(caller.signal)
		caller.abort()
		expect(await draining).toEqual([])
		expect(f.inbox.hasPendingWork).toBe(true)
		expect(await f.inbox.drainAsync(caller.signal)).toEqual([])
		tracking.resolve()
		expect(await f.inbox.drainAsync()).toEqual([handle])
	})

	it('reports a rejected tracking write without waiting for another queued write to finish', async () => {
		const f = fixture()
		const failed = deferred()
		const pending = deferred()
		f.inbox.launched('failed' as TaskId)
		f.inbox.launched('pending' as TaskId)
		f.inbox.deferDelivery('failed' as TaskId, failed.promise)
		f.inbox.deferDelivery('pending' as TaskId, pending.promise)
		f.complete('failed')
		f.complete('pending')
		const draining = f.inbox.drainAsync()
		const error = new Error('One tracking write was rejected')
		failed.reject(error)
		await expect(draining).rejects.toBe(error)
		await expect(f.inbox.drainAsync()).rejects.toBe(error)
		expect(f.inbox.hasPendingWork).toBe(true)
		f.inbox.claim('failed' as TaskId)
		pending.resolve()
		expect((await f.inbox.drainAsync()).map((handle) => handle.taskId)).toEqual(['pending'])
	})

	it('an old drain cannot consume results after the inbox is closed and reused', async () => {
		const f = fixture()
		f.inbox.launched('old' as TaskId)
		const tracking = deferred()
		f.inbox.deferDelivery('old' as TaskId, tracking.promise)
		f.complete('old')
		const oldDrain = f.inbox.drainAsync()
		f.inbox.close()
		f.inbox.attach(f.gateway)
		f.inbox.launched('new' as TaskId)
		const next = f.complete('new')
		expect(await oldDrain).toEqual([])
		expect(f.inbox.drain()).toEqual([next])
		tracking.resolve()
	})

	it('closing the inbox does not cancel the independently owned tracking write', async () => {
		const f = fixture()
		f.inbox.launched('own' as TaskId)
		const tracking = deferred()
		let persisted = false
		f.inbox.deferDelivery(
			'own' as TaskId,
			tracking.promise.then(() => {
				persisted = true
			}),
		)
		f.complete('own')
		const draining = f.inbox.drainAsync()
		f.inbox.close()
		expect(await draining).toEqual([])
		expect(persisted).toBe(false)
		tracking.resolve()
		await tracking.promise
		expect(persisted).toBe(true)
	})
})
