// ses_017 fix-batch — L2 and L10. Both are about the heartbeat, and both used to end with
// the lease saying something false.
//
// L2 — EVERY ERROR FROM `renewLease()` WAS READ AS A TAKEOVER. The catch was bare. But
// `renewLease` can reject for reasons that have nothing to do with contention: `EMFILE` on an
// agent runtime under fd pressure, `ENOSPC`, a transient `EIO`, a `readdir` that failed. A
// single one of those, with no other process anywhere near the run, cleared the interval,
// aborted the controller and drove the run through `handleError` → `markFailed` →
// `finalize()`, which PERSISTED `failed` — and the fence permitted the write, because the
// segment still legitimately held the lease. There was no retry, because the interval was
// already gone. A healthy, uncontended run, durably failed by one bad write.
//
// L10 — `release()` DID NOT WAIT FOR A HEARTBEAT ALREADY IN FLIGHT. `clearInterval` cancels
// the next tick; it does nothing about the renewal halfway through `renewLease()` right now.
// That renewal completes AFTER the release and rewrites the lease file WITHOUT `releasedAt` —
// resurrecting, for a full TTL, a lease that no live segment holds. Every resume of the run
// is then refused `RunLeaseHeldError` on behalf of a process that has already exited, which
// is the exact inverse of the "a parked run is resumable AT ONCE" guarantee that release
// exists to provide.
import { describe, expect, it, vi } from 'vitest'
import type { RunDiskStore } from '../../../store/run/disk.js'
import type { RunId } from '../../../types/ids/index.js'
import { type RunLease, RunLeaseExpiredError, RunLeaseLostError } from '../../../types/run/lease.js'
import { getRootLogger } from '../../../utils/logger.js'
import { RunLeaseHolder } from '../lease.js'

const RUN_ID = 'run_holder' as RunId
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const log = getRootLogger().child({ component: 'test' })

function leaseAt(renewedAt: number, ttlMs: number): RunLease {
	return {
		runId: RUN_ID,
		token: 1,
		holderId: 'segment-A',
		acquiredAt: renewedAt,
		renewedAt,
		ttlMs,
	}
}

/**
 * A store whose renewals the test drives. Everything the holder touches, nothing it does not.
 */
function stubStore(opts: {
	ttlMs: number
	renew: (attempt: number) => Promise<RunLease>
	journal: string[]
}): RunDiskStore {
	let attempt = 0
	return {
		acquireLease: async () => leaseAt(Date.now(), opts.ttlMs),
		renewLease: async () => {
			attempt++
			opts.journal.push(`renew:start:${attempt}`)
			try {
				const lease = await opts.renew(attempt)
				opts.journal.push(`renew:ok:${attempt}`)
				return lease
			} catch (err) {
				opts.journal.push(`renew:fail:${attempt}`)
				throw err
			}
		},
		releaseLease: async () => {
			opts.journal.push('store:release')
		},
		disownLease: async () => {
			opts.journal.push('store:disown')
		},
	} as unknown as RunDiskStore
}

describe('L2 — only a lost lease means the lease was lost', () => {
	it('retries a transient fs error instead of durably failing a healthy, uncontended run', async () => {
		const journal: string[] = []
		const lost = vi.fn()
		const ttlMs = 900

		const holder = await RunLeaseHolder.acquire({
			runId: RUN_ID,
			store: stubStore({
				ttlMs,
				journal,
				renew: async (attempt) => {
					// The disk has a bad moment. Twice. Nothing is contending for this run.
					if (attempt <= 2) {
						const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException
						err.code = 'EMFILE'
						throw err
					}
					return leaseAt(Date.now(), ttlMs)
				},
			}),
			log,
			ttlMs,
			heartbeatMs: 30,
			onLost: lost,
		})

		await sleep(150)
		await holder.release()

		// It kept trying, and it got there. Before this, the FIRST failure aborted the run:
		// interval cleared, controller aborted, `run.json` rewritten to `failed`.
		expect(lost).not.toHaveBeenCalled()
		expect(journal).toContain('renew:fail:1')
		expect(journal).toContain('renew:fail:2')
		expect(journal).toContain('renew:ok:3')
	})

	it('a takeover is not a transient error — it stops AT ONCE, and it is the only thing that does', async () => {
		const journal: string[] = []
		const lost = vi.fn()
		const ttlMs = 900

		await RunLeaseHolder.acquire({
			runId: RUN_ID,
			store: stubStore({
				ttlMs,
				journal,
				renew: async () => {
					throw new RunLeaseLostError(RUN_ID, 1, 2, 'renew the lease')
				},
			}),
			log,
			ttlMs,
			heartbeatMs: 30,
			onLost: lost,
		})

		await sleep(120)

		// One failed renewal, one abort. Every write this segment makes from here is fenced
		// off, so there is nothing to retry FOR.
		expect(lost).toHaveBeenCalledTimes(1)
		expect(lost.mock.calls[0]?.[0]).toBeInstanceOf(RunLeaseLostError)
		expect(journal.filter((j) => j.startsWith('renew:start')).length).toBe(1)
	})

	it('gives up when the TTL runs out — the bound is the lease’s own validity, not a magic number', async () => {
		const journal: string[] = []
		const lost = vi.fn()
		// TTL 90ms, heartbeat floored to 30ms: three renewals per TTL, so a run of consecutive
		// failures crosses `renewedAt + ttlMs` on the third. Change either number and the bound
		// follows it — which is the property a hard-coded `3` would not have.
		const ttlMs = 90

		await RunLeaseHolder.acquire({
			runId: RUN_ID,
			store: stubStore({
				ttlMs,
				journal,
				renew: async () => {
					const err = new Error('EIO: i/o error') as NodeJS.ErrnoException
					err.code = 'EIO'
					throw err
				},
			}),
			log,
			ttlMs,
			heartbeatMs: 30,
			onLost: lost,
		})

		await sleep(250)

		// Past its TTL with no successful renewal, this lease reads `stale` to everybody else
		// and another segment is ENTITLED to take the run over. Carrying on would be driving a
		// run we do not own, so retrying is bounded by exactly the window in which our claim to
		// the run is still true.
		expect(lost).toHaveBeenCalledTimes(1)
		expect(lost.mock.calls[0]?.[0]).toBeInstanceOf(RunLeaseExpiredError)
		// …and it is a RunLeaseLostError, so the segment exits SILENTLY rather than declaring a
		// run it no longer owns to be failed.
		expect(lost.mock.calls[0]?.[0]).toBeInstanceOf(RunLeaseLostError)
		expect(journal.filter((j) => j.startsWith('renew:fail')).length).toBeGreaterThanOrEqual(3)
	})
})

describe('L10 — a released lease stays released', () => {
	it('release() waits for a renewal that is already in flight, so it cannot be resurrected', async () => {
		const journal: string[] = []
		const ttlMs = 900

		let renewReached!: () => void
		const atRenew = new Promise<void>((r) => {
			renewReached = r
		})
		let letRenewFinish!: () => void
		const renewGate = new Promise<void>((r) => {
			letRenewFinish = r
		})

		const holder = await RunLeaseHolder.acquire({
			runId: RUN_ID,
			store: stubStore({
				ttlMs,
				journal,
				renew: async () => {
					renewReached()
					await renewGate
					return leaseAt(Date.now(), ttlMs)
				},
			}),
			log,
			ttlMs,
			heartbeatMs: 20,
			onLost: () => undefined,
		})

		// A heartbeat is inside `renewLease()` right now — it has captured the lease and is
		// about to rewrite the lease file.
		await atRenew

		// …and the segment parks. `clearInterval` does nothing about the renewal in flight.
		const released = holder.release()
		await sleep(30)

		// The release has NOT gone through to the store yet: it is waiting for the renewal,
		// because a renewal that lands after `releasedAt` is stamped rewrites the file without
		// it and the run reads `held` for a full TTL with nobody driving it.
		expect(journal).not.toContain('store:release')

		letRenewFinish()
		await released

		// The renewal finished FIRST, and the release wrote last. That ordering is the whole
		// fix: whatever the heartbeat wrote, `releasedAt` goes on top of it.
		expect(journal.indexOf('store:release')).toBeGreaterThan(journal.indexOf('renew:ok:1'))
	})
})
