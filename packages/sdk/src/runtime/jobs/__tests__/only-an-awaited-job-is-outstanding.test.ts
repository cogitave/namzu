import { describe, expect, it } from 'vitest'

import { type AwaitedJobSource, AwaitedJobs } from '../awaited-jobs.js'
import { type BackgroundJob, UnknownBackgroundJobError } from '../registry.js'

/**
 * The bookkeeping under the kernel's hold.
 *
 * `job-settle-grace.test.ts` pins what the LOOP does with this; these are the
 * edges the loop cannot reach from a scripted run — a registry shared with
 * another owner, a job that finished before the model said it was waiting, an
 * exit announced twice.
 */

function job(overrides: Partial<BackgroundJob> & { id: string }): BackgroundJob {
	return {
		owner: 'run_1',
		command: 'sleep 30',
		status: 'running',
		startedAt: 0,
		...overrides,
	}
}

/** A registry's two methods, without a process behind them. */
function source(jobs: BackgroundJob[]) {
	const listeners = new Set<(exited: BackgroundJob) => void>()
	const api: AwaitedJobSource = {
		get: (id: string) => {
			const found = jobs.find((entry) => entry.id === id)
			if (!found) throw new UnknownBackgroundJobError({ id })
			return found
		},
		onExit: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
	return {
		api,
		announce: (exited: BackgroundJob) => {
			for (const listener of [...listeners]) listener(exited)
		},
		listenerCount: () => listeners.size,
	}
}

describe('an awaited job is the only thing that is outstanding', () => {
	it('records a running job the model said it was waiting on', () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()

		expect(awaited.hasPendingWork).toBe(false)
		awaited.expect('job_1')

		expect(awaited.hasPendingWork).toBe(true)
		expect(awaited.outstandingJobIds).toEqual(['job_1'])
	})

	it('ignores a job that had already stopped', () => {
		// The call that marks it is the call that returns its output, so there
		// is nothing left to hold a turn open for.
		const registry = source([job({ id: 'job_1', status: 'exited', exitCode: 0 })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()

		awaited.expect('job_1')

		expect(awaited.hasPendingWork).toBe(false)
	})

	it('ignores another owner’s job, and an id the registry does not know', () => {
		const registry = source([job({ id: 'job_1', owner: 'run_2' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()

		awaited.expect('job_1')
		expect(() => awaited.expect('job_404')).not.toThrow()

		expect(awaited.hasPendingWork).toBe(false)
	})

	it('drains an exit once, however many times it is announced', async () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')

		const stopped = job({ id: 'job_1', status: 'exited', exitCode: 0 })
		registry.announce(stopped)
		registry.announce(stopped)

		expect(awaited.drain().map((entry) => entry.id)).toEqual(['job_1'])
		expect(awaited.drain()).toEqual([])
		// Delivered is not outstanding: a turn settling now has walked away
		// from nothing.
		expect(awaited.outstandingJobIds).toEqual([])
		expect(awaited.hasPendingWork).toBe(false)
	})

	it('stops counting an exit the model has already been shown', () => {
		// The notice is what the model reads, and it rides out on the next tool
		// result — usually long before any hold opens. The entry left behind
		// here must not then read as news: an exit still counted after its
		// notice was delivered makes every later wait resolve at once, and the
		// wait it ends may be the delegated-task leg's, opened for a worker
		// that really was outstanding.
		const registry = source([job({ id: 'job_1' })])
		let unread = true
		const awaited = new AwaitedJobs(registry.api, 'run_1', () => unread)
		awaited.attach()
		awaited.expect('job_1')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		expect(awaited.hasPendingWork, 'an exit nobody has read yet is work').toBe(true)

		unread = false
		expect(awaited.hasPendingWork).toBe(false)
	})

	it('drops a delivered exit, so a later job’s notice cannot revive it', () => {
		// The channel gate alone is not enough, because the channel is shared.
		// An exit whose notice went out leaves a record behind, and the gate
		// only asks whether ANY notice is queued — so the next job to end,
		// awaited or not, made that record read as news again and bought the
		// model a turn to re-read an exit it had already been shown.
		const registry = source([job({ id: 'job_1' }), job({ id: 'job_2' })])
		let unread = true
		const awaited = new AwaitedJobs(registry.api, 'run_1', () => unread)
		awaited.attach()
		awaited.expect('job_1')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		expect(awaited.hasPendingWork, 'an exit nobody has read yet is work').toBe(true)

		// It rides out on a tool result, which is where an exit normally
		// reaches the model, and the delivery says so.
		unread = false
		awaited.noticesDelivered()

		// `job_2` is a dev server nobody awaited: its exit is none of this
		// adapter's business, but its notice goes on the same channel.
		registry.announce(job({ id: 'job_2', status: 'exited', exitCode: 0 }))
		unread = true

		expect(awaited.hasPendingWork).toBe(false)
		expect(awaited.drain()).toEqual([])
	})

	it('keeps an exit it has no notice to deliver with', () => {
		// The pairing in `takeDelivery`. Taking the exits before knowing
		// whether there is text to carry them discards them on the branch
		// that finds none — nothing delivered, and no record left that the
		// next delivery could carry instead.
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		expect(awaited.takeDelivery(() => undefined)).toBeUndefined()

		const delivered = awaited.takeDelivery(() => 'job_1 exited with code 0')
		expect(delivered?.text).toBe('job_1 exited with code 0')
		expect(delivered?.exits.map((entry) => entry.id)).toEqual(['job_1'])

		// And once delivered they are gone, without the channel being drained
		// to find that out: a notice taken here would be one no tool result
		// ever shows.
		let asked = 0
		expect(
			awaited.takeDelivery(() => {
				asked += 1
				return 'job_1 exited with code 0'
			}),
		).toBeUndefined()
		expect(asked, 'drained the notice channel with nothing to deliver').toBe(0)
	})

	it('goes on waiting for a running job while a read exit sits in the queue', async () => {
		const registry = source([job({ id: 'job_1' }), job({ id: 'job_2' })])
		let unread = true
		const awaited = new AwaitedJobs(registry.api, 'run_1', () => unread)
		awaited.attach()
		awaited.expect('job_1')
		awaited.expect('job_2')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))
		unread = false

		// No real 25ms probe: `waited` can only resolve via a real/announced
		// arrival or its own internal 10s timer, neither of which has happened
		// yet at this point, so an immediately-resolved promise is a
		// deterministic way to observe "still pending" with no clock involved
		// at all — nothing here can flake under load in either direction.
		const waited = awaited.waitForArrival(10_000)
		const early = await Promise.race([
			waited.then(() => 'returned' as const),
			Promise.resolve('waiting' as const),
		])
		expect(early, 'a delivered exit ended the wait for a job still running').toBe('waiting')

		registry.announce(job({ id: 'job_2', status: 'exited', exitCode: 0 }))
		await expect(waited).resolves.toBeUndefined()
	})

	it('goes on waiting for a running job after an unawaited job ends', async () => {
		// The same regression as the delivered-record case above, seen from
		// the wait: `job_1` was read, `job_3` was never awaited, and `job_2`
		// is the one this turn is actually waiting for.
		const registry = source([job({ id: 'job_1' }), job({ id: 'job_2' }), job({ id: 'job_3' })])
		let unread = true
		const awaited = new AwaitedJobs(registry.api, 'run_1', () => unread)
		awaited.attach()
		awaited.expect('job_1')
		awaited.expect('job_2')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))
		unread = false
		awaited.noticesDelivered()
		registry.announce(job({ id: 'job_3', status: 'exited', exitCode: 0 }))
		unread = true

		// Same reasoning as above: `waited` cannot resolve before this race is
		// built, so an immediately-resolved promise observes "still pending"
		// deterministically, with no real timer to race against CI load.
		const waited = awaited.waitForArrival(10_000)
		const early = await Promise.race([
			waited.then(() => 'returned' as const),
			Promise.resolve('waiting' as const),
		])
		expect(early, 'a job nobody awaited ended the wait for one this turn was').toBe('waiting')

		registry.announce(job({ id: 'job_2', status: 'exited', exitCode: 0 }))
		await expect(waited).resolves.toBeUndefined()
	})

	it('says nothing about an exit nobody awaited', () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()

		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		expect(awaited.drain()).toEqual([])
		expect(awaited.hasPendingWork).toBe(false)
	})

	it('subscribes once however often it is attached, and lets go on close', () => {
		// Two subscriptions would record each exit twice, which is the
		// duplicate the drain above exists to prevent.
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.attach()

		expect(registry.listenerCount()).toBe(1)

		awaited.close()
		awaited.close()

		expect(registry.listenerCount()).toBe(0)
	})
})

describe('the wait is bounded and interruptible', () => {
	it('returns at once when nothing is outstanding', async () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()

		// Not a timer this resolves before — there is nothing to wait for, so
		// racing it would end a hold the caller opened for something else.
		await expect(awaited.waitForArrival(60_000)).resolves.toBeUndefined()
	})

	it('returns at once for an exit already in hand, with nothing else reading them', async () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		await expect(awaited.waitForArrival(60_000)).resolves.toBeUndefined()
	})

	it('wakes on the exit it was waiting for', async () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')

		const waited = awaited.waitForArrival(60_000)
		registry.announce(job({ id: 'job_1', status: 'exited', exitCode: 0 }))

		await expect(waited).resolves.toBeUndefined()
	})

	it('releases the waiter when the signal fires, leaving the job outstanding', async () => {
		// Aborting ends the WAIT. The job is untouched, and a turn that settles
		// after this still has to name it.
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')

		const controller = new AbortController()
		const waited = awaited.waitForArrival(60_000, controller.signal)
		controller.abort()

		await expect(waited).resolves.toBeUndefined()
		expect(awaited.outstandingJobIds).toEqual(['job_1'])
		await expect(awaited.waitForArrival(60_000, controller.signal)).resolves.toBeUndefined()
	})

	it('releases a waiter on close rather than holding it to its deadline', async () => {
		const registry = source([job({ id: 'job_1' })])
		const awaited = new AwaitedJobs(registry.api, 'run_1')
		awaited.attach()
		awaited.expect('job_1')

		const waited = awaited.waitForArrival(60_000)
		awaited.close()

		await expect(waited).resolves.toBeUndefined()
	})
})
