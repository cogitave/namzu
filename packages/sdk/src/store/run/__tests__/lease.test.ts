// Current-code invariants asserted (2026-07-13, ses_017 G1/G2):
//
// A run had no owner. Nothing stopped two processes from driving one run's `query()` at
// the same time: both wrote `run.json` and `messages.json`, the last writer won, and the
// other's work — including tools it had already executed — was silently discarded. And a
// crash left no trace at all: a run whose segment died mid-flight read as `awaiting_input`
// forever, indistinguishable from one parked on a human.
//
// The lease closes both, and these are the primitive's own invariants:
//
//   - One holder at a time. `acquireLease` refuses a live lease with `RunLeaseHeldError`.
//   - It EXPIRES. A holder that stops renewing goes stale after `ttlMs` and the run can be
//     taken over — otherwise the first crash locks the run forever, which is the failure
//     mode a lease that is only a claim actually has.
//   - Taking over BUMPS THE FENCING TOKEN, and a stale holder that wakes up and writes is
//     refused (`RunLeaseLostError`). Expiry is a guess; the fence is what makes being
//     wrong about it survivable.
//   - Three distinguishable states, not two: `free` (nobody), `held` (a live segment),
//     `stale` (a segment that stopped renewing). A crashed run must not read as a parked
//     one.
//   - A renewal keeps a lease alive past its original expiry; a renewal by a FENCED holder
//     is refused.
//   - Release frees the run immediately — a parked run is resumable at once, not one TTL
//     later.
//   - The CONTROL plane (a store with no lease: cancel, redemption, operator reads) is
//     deliberately unfenced. A cancel that could not touch a run being driven would be
//     useless.
//   - `transcript.jsonl` is deliberately unfenced: append-only, so a superseded segment's
//     events cannot destroy the new segment's.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunId } from '../../../types/ids/index.js'
import type { Run } from '../../../types/run/index.js'
import { RunLeaseHeldError, RunLeaseLostError } from '../../../types/run/lease.js'
import { RunDiskStore } from '../disk.js'

const RUN_ID = 'run_lease' as RunId

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-lease-'))
}

async function storeFor(baseDir: string): Promise<RunDiskStore> {
	const store = new RunDiskStore({ baseDir })
	await store.initRun(RUN_ID)
	return store
}

function runRecord(status: Run['status'], marker: string): Run {
	return {
		id: RUN_ID,
		status,
		metadata: {
			agentId: 'a',
			agentName: marker,
			config: { model: 'm' },
			provider: 'fake',
		},
		messages: [{ role: 'assistant', content: marker }],
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		currentIteration: 1,
		startedAt: Date.now(),
	} as Run
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('one run, one driver', () => {
	it('refuses a second acquirer while the lease is live, and says who holds it and until when', async () => {
		const baseDir = tmp()
		const first = await storeFor(baseDir)
		const second = await storeFor(baseDir)

		const lease = await first.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })
		expect(lease.token).toBe(1)

		// This is the whole point: a second segment cannot start driving a run somebody
		// else is driving. Not "it writes second" — it does not start.
		const err = await second
			.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-B' })
			.catch((e) => e)
		expect(err).toBeInstanceOf(RunLeaseHeldError)
		expect((err as RunLeaseHeldError).holderId).toBe('segment-A')
		expect((err as RunLeaseHeldError).token).toBe(1)
		expect((err as RunLeaseHeldError).expiresAt).toBe(lease.renewedAt + 60_000)
	})

	it('hands the run straight back on release — a parked run is resumable at once, not one TTL later', async () => {
		const baseDir = tmp()
		const first = await storeFor(baseDir)
		await first.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })

		await first.releaseLease()
		expect((await first.readLease()).status).toBe('free')

		// A 60-second TTL, and the next segment waits none of it.
		const second = await storeFor(baseDir)
		const lease = await second.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-B' })
		expect(lease.token).toBe(2)
	})
})

describe('a lease expires, and expiry is safe because of the fence', () => {
	it('goes stale on a holder that stops renewing, and the run can be taken over', async () => {
		const baseDir = tmp()
		const crashed = await storeFor(baseDir)
		await crashed.acquireLease(RUN_ID, { ttlMs: 50, holderId: 'crashed' })

		expect((await crashed.readLease()).status).toBe('held')
		await sleep(70)
		expect((await crashed.readLease()).status).toBe('stale')

		// The TTL path, not the happy path: nobody released this lease. Without expiry the
		// first crash would lock the run out of resumption for the rest of its life.
		const taker = await storeFor(baseDir)
		const lease = await taker.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'taker' })
		expect(lease.token).toBe(2)
		expect((await taker.readLease()).status).toBe('held')
	})

	it('FENCES the stale holder: it wakes up, writes, and is refused — the run that moved on is intact', async () => {
		const baseDir = tmp()
		const stalled = await storeFor(baseDir)
		await stalled.acquireLease(RUN_ID, { ttlMs: 50, holderId: 'stalled' })

		// It writes fine while it holds the lease.
		await stalled.writeRunMeta(runRecord('running', 'stalled-segment'))

		await sleep(70)

		// The run moves on without it: taken over, driven, completed.
		const taker = await storeFor(baseDir)
		await taker.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'taker' })
		await taker.writeRunMeta(runRecord('completed', 'taker-segment'))
		await taker.writeMessages(runRecord('completed', 'taker-segment'))

		// …and NOW the stalled process wakes up — it was never dead, just stopped for 70ms —
		// and finishes what it was doing. Every one of these writes would have clobbered a
		// completed run with the state of a segment that lost the race an eternity ago.
		await expect(stalled.writeRunMeta(runRecord('failed', 'stalled-segment'))).rejects.toThrow(
			RunLeaseLostError,
		)
		await expect(stalled.writeMessages(runRecord('failed', 'stalled-segment'))).rejects.toThrow(
			RunLeaseLostError,
		)
		await expect(
			stalled.writeCheckpoint({
				id: 'cp_x',
				runId: RUN_ID,
				iteration: 1,
				messages: [],
				tokenUsage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				costInfo: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
				guardState: { iterationCount: 1, elapsedMs: 0 },
				createdAt: Date.now(),
			}),
		).rejects.toThrow(RunLeaseLostError)
		await expect(stalled.renewLease()).rejects.toThrow(RunLeaseLostError)

		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).toBe('completed')
		expect(meta.metadata.agentName).toBe('taker-segment')
	})

	it('a fenced holder does not release the lease it no longer owns', async () => {
		const baseDir = tmp()
		const stalled = await storeFor(baseDir)
		await stalled.acquireLease(RUN_ID, { ttlMs: 50, holderId: 'stalled' })
		await sleep(70)

		const taker = await storeFor(baseDir)
		await taker.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'taker' })

		// Its `finally` runs, eventually. Releasing here would be a write about a run that
		// is not its own — and would tell the world the RUNNING segment's run is free.
		await stalled.releaseLease()

		const view = await taker.readLease()
		expect(view.status).toBe('held')
		expect(view.lease?.holderId).toBe('taker')
	})
})

describe('a renewal is what separates a slow segment from a dead one', () => {
	it('keeps the lease alive past its original expiry', async () => {
		const baseDir = tmp()
		const store = await storeFor(baseDir)
		const first = await store.acquireLease(RUN_ID, { ttlMs: 120, holderId: 'slow' })

		await sleep(80)
		const renewed = await store.renewLease()
		expect(renewed.renewedAt).toBeGreaterThan(first.renewedAt)
		expect(renewed.token).toBe(first.token) // renewal does not mint a new token

		// Past the ORIGINAL expiry, and still held: this is a segment that is working, not
		// one that died.
		await sleep(60)
		expect((await store.readLease()).status).toBe('held')
	})
})

describe('three states, not two', () => {
	it('free / held / stale are distinguishable, and a crashed segment does not read as a parked run', async () => {
		const baseDir = tmp()
		const store = await storeFor(baseDir)

		const never = await store.readLease()
		expect(never.status).toBe('free')
		expect(never.token).toBe(0)
		expect(never.lease).toBeUndefined()

		await store.acquireLease(RUN_ID, { ttlMs: 60, holderId: 'segment-A' })
		const held = await store.readLease()
		expect(held.status).toBe('held')
		expect(held.lease?.holderId).toBe('segment-A')
		expect(held.expiresAt).toBeGreaterThan(Date.now())

		await sleep(80)
		const stale = await store.readLease()
		expect(stale.status).toBe('stale')
		expect(stale.lease?.holderId).toBe('segment-A')
		// The honest operator-facing fact: held by a segment that has not renewed since T.
		expect(stale.lease?.renewedAt).toBe(held.lease?.renewedAt)
		expect(stale.expiresAt).toBeLessThan(Date.now())

		await store.releaseLease()
		const released = await store.readLease()
		expect(released.status).toBe('free')
		expect(released.lease?.releasedAt).toBeDefined()
	})
})

describe('the fence guards the execution plane, not the control plane', () => {
	it('a store with no lease writes freely — a cancel must reach a run somebody is driving', async () => {
		const baseDir = tmp()
		const driver = await storeFor(baseDir)
		await driver.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'segment-A' })
		await driver.writeRunMeta(runRecord('running', 'segment-A'))

		// This is the cancel path: it holds no lease, and it MUST be able to write while a
		// live segment drives the run. Fencing it would make a running run uncancellable —
		// and the durable cancel is the only thing that stops a parked run's tools.
		const control = await storeFor(baseDir)
		const updated = await control.updateRunMeta((meta) => ({ ...meta, status: 'cancelled' }))
		expect(updated?.status).toBe('cancelled')
		expect((await control.readRunMeta())?.status).toBe('cancelled')
	})
})
