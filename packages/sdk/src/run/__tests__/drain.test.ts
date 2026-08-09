/**
 * `drainRuns` — the loop every host had to write itself.
 *
 * These are the single-process properties: what it refuses, what it
 * releases, what it does with a claim it lost. The properties that need
 * REAL processes — exclusivity, fencing, a dead holder — are in
 * `drain-processes.test.ts`, because a claim tested inside one process is
 * arbitrated by the event loop rather than by the store, which is the
 * mechanism under test.
 */

import { describe, expect, it, vi } from 'vitest'

import { InMemoryCheckpointStore } from '../../store/run/checkpoint-memory.js'
import type { IterationCheckpoint } from '../../types/hitl/index.js'
import type { CheckpointId, ProjectId, RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type {
	CheckpointRunScope,
	CheckpointStore,
	DurableRunEntry,
} from '../../types/run/checkpoint-store.js'
import { drainRuns } from '../drain.js'

const TENANT = 'tnt_drain' as TenantId
const PROJECT = 'prj_drain' as ProjectId
const SESSION = 'ses_drain' as SessionId

const listingScope = { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION }

function scope(runId: string): CheckpointRunScope {
	return { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION, runId: runId as RunId }
}

let seq = 0

/** The shape the checkpoint manager writes, so the listing has real rows. */
function checkpoint(runId: string, parked: boolean): IterationCheckpoint {
	seq += 1
	return {
		id: `cp_${seq}` as CheckpointId,
		runId: runId as RunId,
		iteration: 1,
		messages: [],
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 } as IterationCheckpoint['costInfo'],
		guardState: { iterationCount: 1, elapsedMs: 10 },
		createdAt: 1_000 + seq,
		...(parked
			? {
					pending: {
						request: {
							type: 'tool_review',
							runId: runId as RunId,
							checkpointId: `cp_${seq}` as CheckpointId,
							toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
						},
						parkedAt: 1_000,
					} satisfies IterationCheckpoint['pending'],
				}
			: {}),
	}
}

async function seeded(runIds: readonly string[], parked = true): Promise<InMemoryCheckpointStore> {
	const store = new InMemoryCheckpointStore()
	for (const runId of runIds) {
		await store.writeCheckpoint(scope(runId), checkpoint(runId, parked))
	}
	return store
}

/**
 * The seeded store with one capability replaced or removed.
 *
 * Built method by method rather than by spreading the instance. A class's
 * methods live on its prototype, so `{ ...store }` yields an object holding
 * the private maps and NO methods whatever — and a refusal test written that
 * way passes against a `drainRuns` that checks nothing, because the store it
 * was handed genuinely implements nothing. Two of the tests below would have
 * been decorative.
 */
function facade(
	store: InMemoryCheckpointStore,
	over: Partial<CheckpointStore> = {},
): CheckpointStore {
	return {
		writeCheckpoint: (s, c, f) => store.writeCheckpoint(s, c, f),
		readCheckpoint: (s, id) => store.readCheckpoint(s, id),
		listCheckpoints: (s) => store.listCheckpoints(s),
		deleteCheckpoint: (s, id) => store.deleteCheckpoint(s, id),
		listDurableRuns: (s, o) => store.listDurableRuns(s, o),
		claimRun: (s, o) => store.claimRun(s, o),
		releaseRun: (s, f) => store.releaseRun(s, f),
		...over,
	}
}

function without(store: InMemoryCheckpointStore, method: keyof CheckpointStore): CheckpointStore {
	return facade(store, { [method]: undefined })
}

const holder = 'w_test'
const ttlMs = 60_000

describe('refusing a store that cannot arbitrate a queue', () => {
	/**
	 * The point of every case here is the SECOND assertion. A refusal that
	 * fires after the queue has been read and half-drained is not a refusal,
	 * it is a partial outage — and "claimed by default" is the degradation
	 * the optional-capability rule exists to forbid.
	 */
	const cannotClaim: CheckpointStore = {
		writeCheckpoint: async () => {},
		readCheckpoint: async () => null,
		listCheckpoints: async () => [],
		deleteCheckpoint: async () => {},
		listDurableRuns: vi.fn(async () => ({ entries: [] })),
		releaseRun: async () => {},
	}

	it('refuses a store with no claim, and drains nothing', async () => {
		const onRun = vi.fn()
		await expect(
			drainRuns({ store: cannotClaim, scope: listingScope, holder, ttlMs, onRun }),
		).rejects.toThrow(/does not implement `claimRun`/)
		expect(onRun).not.toHaveBeenCalled()
		// Refused BEFORE the listing, not after: a store that cannot claim must
		// not even read the queue, because reading it is what makes "drain what
		// I can" look reasonable.
		expect(cannotClaim.listDurableRuns).not.toHaveBeenCalled()
	})

	it('refuses a store that cannot list', async () => {
		const store: CheckpointStore = {
			writeCheckpoint: async () => {},
			readCheckpoint: async () => null,
			listCheckpoints: async () => [],
			deleteCheckpoint: async () => {},
			claimRun: async () => null,
			releaseRun: async () => {},
		}
		const onRun = vi.fn()
		await expect(drainRuns({ store, scope: listingScope, holder, ttlMs, onRun })).rejects.toThrow(
			/does not implement `listDurableRuns`/,
		)
		expect(onRun).not.toHaveBeenCalled()
	})

	it('refuses a store that cannot release, rather than draining runs it can never give back', async () => {
		const store = await seeded(['run_a'])
		const noRelease = without(store, 'releaseRun')
		const onRun = vi.fn()
		await expect(
			drainRuns({ store: noRelease, scope: listingScope, holder, ttlMs, onRun }),
		).rejects.toThrow(/does not implement.*`releaseRun`/)
		expect(onRun).not.toHaveBeenCalled()
	})

	it('names every missing capability at once', async () => {
		const store: CheckpointStore = {
			writeCheckpoint: async () => {},
			readCheckpoint: async () => null,
			listCheckpoints: async () => [],
			deleteCheckpoint: async () => {},
		}
		await expect(
			drainRuns({ store, scope: listingScope, holder, ttlMs, onRun: () => {} }),
		).rejects.toThrow(/`listDurableRuns`, `claimRun`, `releaseRun`/)
	})
})

describe('refusing configuration that cannot mean what it says', () => {
	it('refuses an empty holder', async () => {
		const store = await seeded(['run_a'])
		await expect(
			drainRuns({ store, scope: listingScope, holder: '  ', ttlMs, onRun: () => {} }),
		).rejects.toThrow(/`holder` is empty/)
	})

	it('refuses a lease that has already expired', async () => {
		const store = await seeded(['run_a'])
		await expect(
			drainRuns({ store, scope: listingScope, holder, ttlMs: 0, onRun: () => {} }),
		).rejects.toThrow(/ttlMs must be a positive number/)
	})

	it('refuses a concurrency of zero rather than reporting an empty pass', async () => {
		const store = await seeded(['run_a'])
		const onRun = vi.fn()
		await expect(
			drainRuns({ store, scope: listingScope, holder, ttlMs, onRun, maxConcurrent: 0 }),
		).rejects.toThrow(/maxConcurrent must be a positive integer/)
		expect(onRun).not.toHaveBeenCalled()
	})
})

describe('one pass over the queue', () => {
	it('takes every unclaimed run and hands each one its own claim', async () => {
		const store = await seeded(['run_a', 'run_b', 'run_c'])
		const seen: { runId: string; fence: number; holder: string }[] = []

		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: (entry, claim) => {
				seen.push({ runId: entry.runId, fence: claim.fence, holder: claim.holder })
			},
		})

		expect(result.listed).toBe(3)
		expect([...result.drained].sort()).toEqual(['run_a', 'run_b', 'run_c'])
		expect(result.skipped).toEqual([])
		expect(result.failed).toEqual([])
		expect(result.unreleased).toEqual([])
		expect(result.stopped).toBe(false)
		expect(seen.map((s) => s.runId).sort()).toEqual(['run_a', 'run_b', 'run_c'])
		// A fence per run, and the holder the caller named. Asserted because a
		// drainer that passed the ENTRY and not the claim would still look
		// correct on every count above.
		expect(seen.every((s) => s.fence === 1 && s.holder === holder)).toBe(true)
	})

	it('gives every run back, so a second pass sees the same queue', async () => {
		const store = await seeded(['run_a', 'run_b'])
		await drainRuns({ store, scope: listingScope, holder, ttlMs, onRun: () => {} })

		const second = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
		})
		// Without the release, both runs would still be held at their first
		// fence and this pass would list nothing — the failure that makes a
		// drainer look like it drained the queue exactly once and then broke.
		expect([...second.drained].sort()).toEqual(['run_a', 'run_b'])
		// And the second holding is a NEW fence, which is what proves the first
		// one was surrendered rather than renewed.
		const page = await store.listDurableRuns(listingScope, {})
		expect(page.entries.every((e) => e.claim === undefined)).toBe(true)
	})

	it('releases a run whose work threw, and keeps going', async () => {
		const store = await seeded(['run_a', 'run_b'])
		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: (entry) => {
				if (entry.runId === 'run_a') throw new Error('the work blew up')
			},
		})

		expect(result.failed).toEqual([{ runId: 'run_a', error: 'the work blew up' }])
		// The other run was still drained. A drainer that stopped at the first
		// failure leaves the rest of the queue for nobody.
		expect(result.drained).toEqual(['run_b'])
		// And the FAILED run is back on the queue immediately rather than stuck
		// for a full lease — the case a `finally` exists for, and the one a
		// release-on-success-only implementation gets wrong.
		const page = await store.listDurableRuns(listingScope, { claimed: false })
		expect(page.entries.map((e) => e.runId).sort()).toEqual(['run_a', 'run_b'])
	})

	it('skips a run somebody else took between the listing and the claim', async () => {
		const store = await seeded(['run_a', 'run_b'])
		// The race the `null` return exists for: listed as free, gone by the
		// time this drainer asked.
		const raced = facade(store, {
			claimRun: async (s, o) => (s.runId === 'run_a' ? null : store.claimRun(s, o)),
		})
		const onRun = vi.fn()

		const result = await drainRuns({ store: raced, scope: listingScope, holder, ttlMs, onRun })

		expect(result.skipped).toEqual(['run_a'])
		expect(result.drained).toEqual(['run_b'])
		// Not a failure. "Somebody got there first" is the ordinary outcome of
		// two readers on one queue, and reporting it as a fault would make a
		// healthy two-worker deployment look broken.
		expect(result.failed).toEqual([])
		expect(onRun).toHaveBeenCalledTimes(1)
	})

	it('reports a lease it could not hand back without losing the work', async () => {
		const store = await seeded(['run_a'])
		const stuck = facade(store, {
			releaseRun: async () => {
				throw new Error('disk went away')
			},
		})
		const result = await drainRuns({
			store: stuck,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
		})
		// The work succeeded and is reported as such; the release problem is a
		// separate fact with a separate consequence (throughput, never
		// correctness), so it does not masquerade as a failed run.
		expect(result.drained).toEqual(['run_a'])
		expect(result.failed).toEqual([])
		expect(result.unreleased).toEqual([{ runId: 'run_a', error: 'disk went away' }])
	})

	it('does not rethrow a release failure over the work failure it is unwinding', async () => {
		const store = await seeded(['run_a'])
		const stuck = facade(store, {
			releaseRun: async () => {
				throw new Error('disk went away')
			},
		})
		const result = await drainRuns({
			store: stuck,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {
				throw new Error('the work blew up')
			},
		})
		// The caller has to be able to see WHY the run failed. A `finally` that
		// throws replaces the original error, and the operator then debugs the
		// disk instead of the run.
		expect(result.failed).toEqual([{ runId: 'run_a', error: 'the work blew up' }])
		expect(result.unreleased.map((u) => u.runId)).toEqual(['run_a'])
	})

	it('never offers a run another worker currently holds', async () => {
		const store = await seeded(['run_a', 'run_b'])
		await store.claimRun(scope('run_a'), { holder: 'other_worker', ttlMs: 60_000 })

		const result = await drainRuns({ store, scope: listingScope, holder, ttlMs, onRun: () => {} })

		// `claimed: false` is not a parameter, and this is why: a drainer that
		// listed held runs would spend a claim attempt on every one of them
		// every pass.
		expect(result.listed).toBe(1)
		expect(result.drained).toEqual(['run_b'])
	})

	it('offers a run whose holder has expired, because that is what expiry means', async () => {
		const store = await seeded(['run_a'])
		await store.claimRun(scope('run_a'), { holder: 'crashed', ttlMs: 1, now: 1_000 })

		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
			now: 100_000,
		})

		expect(result.drained).toEqual(['run_a'])
		// The reclaimer's fence is strictly greater than the dead holder's, so
		// the dead holder's late write is refused rather than accepted beside
		// this one.
		expect(result.listed).toBe(1)
	})

	it('gives back a run that stopped matching between the listing and the claim', async () => {
		const store = await seeded(['run_a', 'run_b'])
		const onRun = vi.fn()

		// The window a claim cannot close: another drainer answered `run_a`'s
		// park and released it after this pass had already paged the row. The
		// claim then SUCCEEDS on work somebody else finished.
		const raced = facade(store, {
			claimRun: async (s, o) => {
				const claim = await store.claimRun(s, o)
				if (claim && s.runId === 'run_a') {
					const [seed] = await store.listCheckpoints(s)
					await store.writeCheckpoint(
						s,
						{
							...(seed as IterationCheckpoint),
							pending: {
								...(seed as IterationCheckpoint).pending,
								resolvedAt: 2_000,
							} as IterationCheckpoint['pending'],
						},
						claim.fence,
					)
				}
				return claim
			},
		})

		const result = await drainRuns({
			store: raced,
			scope: listingScope,
			holder,
			ttlMs,
			onRun,
			park: ['outstanding'],
		})

		expect(result.stale).toEqual(['run_a'])
		expect(result.drained).toEqual(['run_b'])
		// The point of the whole re-read: the work does NOT run a second time.
		expect(onRun).toHaveBeenCalledTimes(1)
		expect(onRun.mock.calls[0]?.[0]).toMatchObject({ runId: 'run_b' })
		// And the stale run's lease is handed straight back rather than held
		// for the full TTL over work nobody is doing.
		const page = await store.listDurableRuns(listingScope, { claimed: false })
		expect(page.entries.map((e) => e.runId)).toContain('run_a')
	})

	it('re-reads nothing when it was given no filter to re-read against', async () => {
		const store = await seeded(['run_a'])
		const listCheckpoints = vi.fn(store.listCheckpoints.bind(store))
		const watched = facade(store, { listCheckpoints })

		const result = await drainRuns({
			store: watched,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
		})

		expect(result.drained).toEqual(['run_a'])
		expect(result.stale).toEqual([])
		// A crash sweep has no predicate a store can re-check, so the extra
		// read would cost a page per run and answer nothing. Exactly-once for
		// that shape comes from the host's own run records inside `onRun`.
		expect(listCheckpoints).not.toHaveBeenCalled()
	})

	it('passes the park filter through instead of inventing one', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(scope('run_parked'), checkpoint('run_parked', true))
		await store.writeCheckpoint(scope('run_crashed'), checkpoint('run_crashed', false))

		const inbox = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
			park: ['outstanding'],
		})
		expect(inbox.drained).toEqual(['run_parked'])

		// And with no filter, the run that never parked is included — the case
		// a crash sweep exists for, and the one any default park filter would
		// have hidden.
		const sweep = await drainRuns({ store, scope: listingScope, holder, ttlMs, onRun: () => {} })
		expect([...sweep.drained].sort()).toEqual(['run_crashed', 'run_parked'])
	})
})

describe('bounds', () => {
	it('pages until the listing is exhausted', async () => {
		const ids = Array.from({ length: 7 }, (_, i) => `run_${i}`)
		const store = await seeded(ids)

		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: () => {},
			pageSize: 2,
		})

		expect(result.listed).toBe(7)
		expect([...result.drained].sort()).toEqual([...ids].sort())
	}, 10_000)

	it('holds no more leases at once than it was allowed', async () => {
		const store = await seeded(Array.from({ length: 6 }, (_, i) => `run_${i}`))
		let inFlight = 0
		let peak = 0

		await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			maxConcurrent: 2,
			onRun: async () => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await new Promise((r) => setTimeout(r, 1))
				inFlight -= 1
			},
		})

		// The obvious implementation — claim the page, then `Promise.all` —
		// holds six leases while doing one run's worth of work, so the tail of
		// the batch expires before it is started.
		expect(peak).toBe(2)
	})

	it('defaults to one run at a time', async () => {
		const store = await seeded(['run_a', 'run_b', 'run_c'])
		let inFlight = 0
		let peak = 0
		await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: async () => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await new Promise((r) => setTimeout(r, 1))
				inFlight -= 1
			},
		})
		expect(peak).toBe(1)
	})
})

describe('cancellation', () => {
	it('stops taking new runs once the signal aborts, and says it stopped', async () => {
		const store = await seeded(['run_a', 'run_b', 'run_c'])
		const controller = new AbortController()
		const seen: string[] = []

		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			signal: controller.signal,
			onRun: (entry) => {
				seen.push(entry.runId)
				controller.abort()
			},
		})

		expect(seen).toHaveLength(1)
		expect(result.drained).toHaveLength(1)
		expect(result.stopped).toBe(true)
		// Everything it did not start is still on the queue and unclaimed — a
		// cancelled pass must not leave leases behind it.
		const page = await store.listDurableRuns(listingScope, { claimed: false })
		expect(page.entries).toHaveLength(3)
	})

	it('claims nothing at all when the signal is already aborted', async () => {
		const store = await seeded(['run_a', 'run_b'])
		const onRun = vi.fn()
		const result = await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			signal: AbortSignal.abort(),
			onRun,
		})
		expect(onRun).not.toHaveBeenCalled()
		expect(result.stopped).toBe(true)
		expect(result.listed).toBe(0)
	})
})

describe('what the callback receives', () => {
	it('hands over an entry that is itself an addressable run scope', async () => {
		const store = await seeded(['run_a'])
		let received: DurableRunEntry | undefined
		await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: (entry) => {
				received = entry
			},
		})
		// The property `resumeRun({ scope: entry, … })` depends on: a row that
		// cannot be turned back into a scope is a report, not a work queue.
		expect(received).toMatchObject({
			tenantId: TENANT,
			projectId: PROJECT,
			sessionId: SESSION,
			runId: 'run_a',
		})
		expect(received?.latestCheckpointId).toBeDefined()
	})

	it('hands over a fence that the store will accept and a stale one it will not', async () => {
		const store = await seeded(['run_a'])
		let fence = 0
		await drainRuns({
			store,
			scope: listingScope,
			holder,
			ttlMs,
			onRun: async (entry, claim) => {
				fence = claim.fence
				// The whole reason the claim is handed over: this write is fenced.
				await store.writeCheckpoint(entry, checkpoint('run_a', false), claim.fence)
			},
		})
		expect(fence).toBe(1)

		// A second holding supersedes the first, and the first holder's write is
		// refused. Without the fence reaching `onRun`, a stalled worker would
		// overwrite the record of whoever took the run over.
		// 3, not 2: `releaseRun` steps the counter past the holding it gave up
		// (the disk store appends a tombstone at `fence + 1` and this store
		// matches it), so a released holder cannot write with the fence it just
		// surrendered. Asserted at the exact number rather than
		// `toBeGreaterThan(fence)`, because the loose form passes against a
		// release that quietly did nothing.
		const second = await store.claimRun(scope('run_a'), { holder: 'w_two', ttlMs })
		expect(second?.fence).toBe(3)
		await expect(
			store.writeCheckpoint(scope('run_a'), checkpoint('run_a', false), fence),
		).rejects.toThrow(/refusing a write/)
	})
})
