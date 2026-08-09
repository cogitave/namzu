import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type {
	CheckpointId,
	ProjectId,
	RunId,
	SessionId,
	TenantId,
} from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import { DiskCheckpointStore } from '../checkpoint-disk.js'
import { InMemoryCheckpointStore } from '../checkpoint-memory.js'
import { claimRun, listDurableRuns, releaseRun } from '../listing.js'

/**
 * Two workers draining a queue are two PROCESSES. A single-process test of a
 * cross-process claim proves the thing it was written to test cannot be
 * observed — the arbitration passes through one `Map` or one module instance
 * and the race never happens. So the contention test below spawns real
 * children that share nothing but a directory.
 *
 * Everything else here is about the two facts a lease has to get right and a
 * mutex does not: it expires, and a holder that stalls past its expiry does
 * not know it.
 */

const T1 = 'tnt_claim' as TenantId
const P1 = 'prj_claim' as ProjectId
const S1 = 'ses_claim' as SessionId

function scope(runId = 'run_a'): CheckpointRunScope {
	return { tenantId: T1, projectId: P1, sessionId: S1, runId: runId as RunId }
}

let seq = 0
function checkpoint(runId = 'run_a'): IterationCheckpoint {
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
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: Date.now(),
	}
}

const NOW = 5_000_000

/**
 * Both shipped stores answer the same suite. A claim implemented one way in
 * memory and another on disk is two claims, and a host tests against one and
 * ships the other.
 */
const BACKENDS: readonly ['in-memory' | 'disk', (dir: string) => CheckpointStore][] = [
	['in-memory', () => new InMemoryCheckpointStore()],
	// The disk store is the one a host actually gets, and the only one whose
	// arbitration has to survive leaving the process.
	[
		'disk',
		(dir) =>
			new DiskCheckpointStore({ baseDir: dir }, { tenantId: T1, projectId: P1, sessionId: S1 }),
	],
]

describe.each(BACKENDS)('a run claim (%s)', (_kind, make) => {
	let dir: string
	let store: CheckpointStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-claim-'))
		store = make(dir)
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	it('gives the run to the first taker and refuses the second', async () => {
		const first = await claimRun(store, scope(), { holder: 'w1', ttlMs: 60_000, now: NOW })
		const second = await claimRun(store, scope(), { holder: 'w2', ttlMs: 60_000, now: NOW })

		expect(first?.holder).toBe('w1')
		// `null`, not a throw: two readers on one queue is the ordinary case,
		// and an exception would make the normal outcome look like a fault.
		expect(second).toBeNull()
	})

	it('lets a later worker take a run whose holder went away', async () => {
		const first = await claimRun(store, scope(), { holder: 'w1', ttlMs: 1_000, now: NOW })
		const second = await claimRun(store, scope(), {
			holder: 'w2',
			ttlMs: 60_000,
			now: NOW + 2_000,
		})

		// A lock held by a dead process is held forever. The expiry is the
		// whole difference between a lease and a wedged run.
		expect(second?.holder).toBe('w2')
		expect(second?.fence).toBeGreaterThan(first?.fence as number)
	})

	it('fences the stalled holder out at the moment it writes', async () => {
		const first = await claimRun(store, scope(), { holder: 'w1', ttlMs: 1_000, now: NOW })
		await claimRun(store, scope(), { holder: 'w2', ttlMs: 60_000, now: NOW + 2_000 })

		// `w1` believes it still holds the run. It cannot know otherwise: a
		// long pause, a suspended container and a partition all look from the
		// inside like time not passing. The write is the only place it can be
		// told, and this is that place.
		await expect(store.writeCheckpoint(scope(), checkpoint(), first?.fence)).rejects.toThrow(
			/no longer holds it/,
		)
	})

	it('lets the current holder keep writing', async () => {
		const claim = await claimRun(store, scope(), { holder: 'w1', ttlMs: 60_000, now: NOW })
		await expect(
			store.writeCheckpoint(scope(), checkpoint(), claim?.fence),
		).resolves.toBeUndefined()
	})

	it('advances the fence on renewal, so a stalled twin cannot write', async () => {
		const first = await claimRun(store, scope(), { holder: 'w1', ttlMs: 1_000, now: NOW })
		const renewed = await claimRun(store, scope(), { holder: 'w1', ttlMs: 60_000, now: NOW + 500 })

		// Renewal and reclamation are one operation, and both advance. A
		// renewal that kept the fence would leave any duplicate of the holder
		// — a retried job, a double-scheduled pod — able to write with the
		// number it captured before.
		expect(renewed?.fence).toBeGreaterThan(first?.fence as number)
		await expect(store.writeCheckpoint(scope(), checkpoint(), first?.fence)).rejects.toThrow(
			/no longer holds it/,
		)
	})

	it('still accepts an unfenced write on a claimed run', async () => {
		await claimRun(store, scope(), { holder: 'w1', ttlMs: 60_000, now: NOW })
		// A host that adopts claims on one worker must not break the workers
		// that have not adopted them yet. Refusing here would make the
		// capability impossible to roll out incrementally.
		await expect(store.writeCheckpoint(scope(), checkpoint())).resolves.toBeUndefined()
	})

	it('releases only on the fence that currently holds it', async () => {
		const first = await claimRun(store, scope(), { holder: 'w1', ttlMs: 1_000, now: NOW })
		await claimRun(store, scope(), { holder: 'w2', ttlMs: 60_000, now: NOW + 2_000 })

		// A worker that stalled past its lease must not be able to hand away
		// a run somebody else is now holding.
		await releaseRun(store, scope(), first?.fence as number)

		const third = await claimRun(store, scope(), { holder: 'w3', ttlMs: 60_000, now: NOW + 3_000 })
		expect(third).toBeNull()
	})

	it('returns the run to the queue when its holder releases', async () => {
		const claim = await claimRun(store, scope(), { holder: 'w1', ttlMs: 60_000, now: NOW })
		await releaseRun(store, scope(), claim?.fence as number)

		const next = await claimRun(store, scope(), { holder: 'w2', ttlMs: 60_000, now: NOW + 1 })
		expect(next?.holder).toBe('w2')
	})

	it('shows the queue reader which runs nobody holds', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a'))
		await store.writeCheckpoint(scope('run_b'), checkpoint('run_b'))
		await store.writeCheckpoint(scope('run_c'), checkpoint('run_c'))

		await claimRun(store, scope('run_a'), { holder: 'w1', ttlMs: 60_000, now: NOW })
		await claimRun(store, scope('run_b'), { holder: 'w1', ttlMs: 1_000, now: NOW })

		const free = await listDurableRuns(
			store,
			{ tenantId: T1 },
			{ claimed: false, now: NOW + 2_000 },
		)
		// `run_b`'s holder is gone. An expired claim counts as unheld, or a
		// dead worker's runs stay invisible forever — the failure the lease
		// exists to prevent, reintroduced by the filter that reads it.
		expect(free.entries.map((e) => e.runId)).toEqual(['run_b', 'run_c'])

		const taken = await listDurableRuns(
			store,
			{ tenantId: T1 },
			{ claimed: true, now: NOW + 2_000 },
		)
		expect(taken.entries.map((e) => e.runId)).toEqual(['run_a'])
		expect(taken.entries[0]?.claim?.holder).toBe('w1')
		expect(taken.entries[0]?.claim?.expired).toBe(false)
	})

	it('refuses a lease with no duration', async () => {
		// A lease that expires immediately is a lease every worker can take at
		// once, which is the condition this call exists to prevent.
		await expect(claimRun(store, scope(), { holder: 'w1', ttlMs: 0, now: NOW })).rejects.toThrow(
			/positive number of milliseconds/,
		)
	})
})

describe('a store that cannot arbitrate', () => {
	const cannot: CheckpointStore = {
		writeCheckpoint: async () => {},
		readCheckpoint: async () => null,
		listCheckpoints: async () => [],
		deleteCheckpoint: async () => {},
	}

	it('refuses to claim rather than proceeding unclaimed', async () => {
		// Skipping an absent optional method is the natural thing to do and
		// the fatal one: every worker would proceed believing it holds a run
		// nobody arbitrated.
		await expect(claimRun(cannot, scope(), { holder: 'w1', ttlMs: 1_000 })).rejects.toThrow(
			/does not implement `claimRun`/,
		)
	})

	it('refuses to release rather than pretending it did', async () => {
		await expect(releaseRun(cannot, scope(), 1)).rejects.toThrow(/does not implement `releaseRun`/)
	})
})

// ── the one that needs real processes ────────────────────────────────────

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

describe('processes racing for one run', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-race-'))
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	/**
	 * How many runs each race contends over.
	 *
	 * Not one. The window a check-then-act implementation loses is
	 * microseconds wide, and two processes released at the same millisecond
	 * usually still miss each other — a single-run race reported "correct"
	 * against an implementation with no exclusion in it at all, which is a
	 * test passing while proving nothing. Hundreds of attempts back to back
	 * turn a rare interleaving into a near-certain one.
	 */
	const RUNS = 300

	/**
	 * Race `workers` processes over a batch of runs, all released together.
	 *
	 * Returns the fences won per run, not just a count. The count alone cannot
	 * tell a reclaim from a fresh take, and one of the two tests below is about
	 * exactly that difference.
	 */
	async function race(prefix: string, workers = 3): Promise<Map<string, number[]>> {
		// Built output, not source: separate node processes with no loader,
		// sharing nothing but `dir`.
		const dist = join(here, '..', '..', '..', '..', 'dist')
		const worker = join(here, 'claim-worker.mjs')
		// A barrier past node's startup, which varies by tens of milliseconds
		// — easily enough for one worker to finish the whole batch before
		// another begins, and contenders that never overlap are not
		// contending.
		const at = String(Date.now() + 1_500)

		const results = await Promise.all(
			Array.from({ length: workers }, (_, i) =>
				exec(process.execPath, [worker, dist, dir, prefix, String(RUNS), `w${i}`, '60000', at]),
			),
		)

		const claimsPerRun = new Map<string, number[]>()
		for (const r of results) {
			const { won } = JSON.parse(r.stdout.trim()) as {
				won: { runId: string; fence: number }[]
			}
			for (const w of won)
				claimsPerRun.set(w.runId, [...(claimsPerRun.get(w.runId) ?? []), w.fence])
		}
		return claimsPerRun
	}

	it('issues each run to exactly one worker', async () => {
		const claims = await race('run_fresh_')
		expect(claims.size).toBe(RUNS)
		// None claimed twice. Two holders of one run both restore the same
		// checkpoint, both execute its tools and both write under one run id.
		expect([...claims.values()].filter((f) => f.length !== 1)).toEqual([])
		// A run nobody has held starts at 1. Stated so the reclaim test below
		// has something to differ from.
		expect([...claims.values()].filter((f) => f[0] !== 1)).toEqual([])
	}, 60_000)

	it('issues a dead holder’s run to exactly one reclaimer', async () => {
		// A different mechanism from the one above, so it needs its own race.
		// Taking a free run is a single exclusive create and the kernel picks
		// the winner. RECLAIMING reads the current holding, judges it expired,
		// and takes the NEXT number — and two workers that both read the same
		// expired holding must not both end up with one fence, which would
		// fence neither of them out.
		//
		// The seed is a holding, at `claims/7.json`. It used to be a
		// `claim.json` in the run directory, and that file stopped being read
		// when the fence became the file name — so this test seeded something
		// nothing looked at, every run started from an empty counter, and it
		// re-ran the fresh case above under a different name while its comment
		// claimed otherwise. The fence assertion below is what makes the
		// difference observable: 8 can only come from having read the 7.
		for (let i = 0; i < RUNS; i++) {
			const claimsDir = join(dir, `run_dead_${i}`, 'claims')
			await mkdir(claimsDir, { recursive: true })
			await writeFile(
				join(claimsDir, '7.json'),
				JSON.stringify({ holder: 'crashed', expiresAt: Date.now() - 60_000 }),
				'utf-8',
			)
		}

		const claims = await race('run_dead_')
		expect(claims.size).toBe(RUNS)
		expect([...claims.values()].filter((f) => f.length !== 1)).toEqual([])
		// Every reclaimer landed on 8: it read the dead holder's 7 and took the
		// next number. Anything at 1 means the seed was invisible and this test
		// is the fresh-claim test wearing a different name.
		expect([...claims.values()].filter((f) => f[0] !== 8)).toEqual([])
	}, 60_000)
})
