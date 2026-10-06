import { afterEach, expect, it, vi } from 'vitest'
import type { BackgroundWorkStatusEvent } from '../shared/background-work-protocol.js'
import {
	type BackgroundWorkOwner,
	BackgroundWorkStatusTracker,
	summarizeBackgroundWork,
} from './background-work-status.js'

const trackers: BackgroundWorkStatusTracker[] = []
afterEach(() => {
	for (const tracker of trackers.splice(0)) tracker.close()
	vi.useRealTimers()
})

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function owner(sessionId: string, connection: object = {}): BackgroundWorkOwner {
	return { projectId: 'project', sessionId, runtimeSessionId: sessionId, connection }
}

function job(status: string, exitCode?: number) {
	return {
		id: 'job_1',
		command: 'private command never published',
		status,
		startedAt: 1,
		...(exitCode === undefined ? {} : { exitCode }),
	}
}

function setup() {
	vi.useFakeTimers()
	vi.setSystemTime(1_000)
	const events: BackgroundWorkStatusEvent[] = []
	const tracker = new BackgroundWorkStatusTracker((event) => events.push(event))
	trackers.push(tracker)
	return { tracker, events }
}

it('publishes only fresh metadata and refuses malformed registry rows', () => {
	expect(summarizeBackgroundWork([job('running')], 1_000)).toEqual({
		state: 'known',
		runningCount: 1,
		needsAttention: false,
		checkedAt: 1_000,
		expiresAt: 16_000,
	})
	expect(JSON.stringify(summarizeBackgroundWork([job('running')], 1_000))).not.toContain(
		'private command',
	)
	expect(summarizeBackgroundWork([job('exited', 2)], 1_000)).toMatchObject({
		state: 'known',
		runningCount: 0,
		needsAttention: true,
	})
	expect(
		summarizeBackgroundWork([{ ...job('running'), recoveryRequired: true }], 1_000),
	).toMatchObject({
		state: 'known',
		runningCount: 1,
		needsAttention: true,
	})
	expect(summarizeBackgroundWork([job('exited')], 1_000)).toMatchObject({
		state: 'known',
		needsAttention: false,
	})
	expect(summarizeBackgroundWork([job('guess')], 1_000)).toEqual({ state: 'unknown' })
	expect(summarizeBackgroundWork({ jobs: [] }, 1_000)).toEqual({ state: 'unknown' })
})

it('shares one serialized pump across sessions and notices an exit after the turn', async () => {
	const { tracker, events } = setup()
	const first = deferred<unknown>()
	const readsA = vi
		.fn()
		.mockReturnValueOnce(first.promise)
		.mockResolvedValue([job('exited', 2)])
	const readsB = vi.fn().mockResolvedValue([])
	tracker.observe(owner('a'), readsA, () => true)
	tracker.observe(owner('b'), readsB, () => true)
	await Promise.resolve()
	expect(readsA).toHaveBeenCalledTimes(1)
	expect(readsB).not.toHaveBeenCalled()
	first.resolve([job('running')])
	await vi.advanceTimersByTimeAsync(1_000)
	expect(readsB).toHaveBeenCalledTimes(1)
	expect(events.find((event) => event.sessionId === 'a')?.status).toMatchObject({
		state: 'known',
		runningCount: 1,
	})
	await vi.advanceTimersByTimeAsync(2_000)
	expect(readsA).toHaveBeenCalledTimes(2)
	expect(events.at(-1)?.status).toMatchObject({
		state: 'known',
		runningCount: 0,
		needsAttention: true,
	})
	await vi.advanceTimersByTimeAsync(12_000)
	expect(readsA).toHaveBeenCalledTimes(2)
	expect(tracker.snapshot().a).toMatchObject({ state: 'known', needsAttention: true })
	await vi.advanceTimersByTimeAsync(3_000)
	expect(events.at(-1)?.status).toEqual({ state: 'unknown' })
	expect(readsA).toHaveBeenCalledTimes(2)
	expect(readsB).toHaveBeenCalledTimes(1)
})

it('drops a replaced owner’s late answer and emits unknown on connection invalidation', async () => {
	const { tracker, events } = setup()
	const old = deferred<unknown>()
	const oldClient = {}
	const newClient = {}
	tracker.observe(
		owner('a', oldClient),
		() => old.promise,
		() => true,
	)
	await Promise.resolve()
	tracker.invalidate('a')
	tracker.observe(
		owner('a', newClient),
		async () => [],
		() => true,
	)
	old.resolve([job('running')])
	await vi.advanceTimersByTimeAsync(1_000)
	expect(
		events.some((event) => event.status.state === 'known' && event.status.runningCount > 0),
	).toBe(false)
	expect(tracker.snapshot().a).toMatchObject({ state: 'known', runningCount: 0 })
})

it('retires a running badge at its freshness deadline even while a read is held', async () => {
	const { tracker, events } = setup()
	const held = deferred<unknown>()
	const read = vi
		.fn()
		.mockResolvedValueOnce([job('running')])
		.mockReturnValueOnce(held.promise)
	tracker.observe(owner('a'), read, () => true)
	await vi.advanceTimersByTimeAsync(2_000)
	expect(read).toHaveBeenCalledTimes(2)
	await vi.advanceTimersByTimeAsync(13_000)
	expect(events.at(-1)?.status).toEqual({ state: 'unknown' })
	expect(tracker.snapshot().a).toEqual({ state: 'unknown' })
	held.resolve([])
	await Promise.resolve()
	await Promise.resolve()
	expect(tracker.snapshot().a).toMatchObject({ state: 'known', runningCount: 0 })
})

it('reports a failed read as unknown and does not turn it into zero running jobs', async () => {
	const { tracker, events } = setup()
	const read = vi
		.fn()
		.mockResolvedValueOnce([job('running')])
		.mockRejectedValueOnce(new Error('offline'))
	tracker.observe(owner('a'), read, () => true)
	await vi.advanceTimersByTimeAsync(2_000)
	expect(events.at(-1)?.status).toEqual({ state: 'unknown' })
	expect(tracker.snapshot().a).toEqual({ state: 'unknown' })
})
