import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import type { ProjectId, RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import { DiskCheckpointStore } from '../checkpoint-disk.js'
import { InMemoryCheckpointStore } from '../checkpoint-memory.js'
import {
	CHECKPOINT_STORE_CONTRACT_VERSION,
	defineCheckpointStoreConformance,
} from '../conformance.js'
import { claimRun, releaseRun } from '../listing.js'

/**
 * Two workers draining a queue are two PROCESSES. A single-process test of a
 * cross-process claim proves the thing it was written to test cannot be
 * observed — the arbitration passes through one `Map` or one module instance
 * and the race never happens. So the contention test below spawns real
 * children that share nothing but a directory.
 *
 * Everything a single process CAN establish about the lease — exclusivity,
 * expiry, that a superseded write is refused, that a listing answers for one
 * tenant only — now lives in `../conformance.ts` and ships, because the
 * in-memory store calls itself the reference a host reads when writing a
 * backend of its own and that claim was worth exactly nothing while the suite
 * backing it was unpublishable. Both shipped backends answer it below.
 *
 * What stays here is what is not a property of the CONTRACT: the real-process
 * race, which no host can run against its own store without this repository's
 * worker script, and the refusals the `listing.ts` helpers raise for a store
 * that implements neither.
 */

const scope = (runId: string): CheckpointRunScope => ({
	tenantId: 'tnt_claim' as TenantId,
	projectId: 'prj_claim' as ProjectId,
	sessionId: 'ses_claim' as SessionId,
	runId: runId as RunId,
})

/**
 * Both shipped stores answer the same suite. A claim implemented one way in
 * memory and another on disk is two claims, and a host tests against one and
 * ships the other.
 */
defineCheckpointStoreConformance({
	describe,
	it,
	expect,
	label: 'in-memory',
	// The literal, not the imported constant — see the constant's own note.
	// Re-exporting it into this slot would make the check unfailable.
	contractVersion: 1,
	// The only implementation that can hold more than one tenant at once: the
	// disk layout has no tenant segment in it.
	capabilities: { claims: true, listing: true, multiTenant: true },
	makeStore: () => ({ store: new InMemoryCheckpointStore() }),
})

defineCheckpointStoreConformance({
	describe,
	it,
	expect,
	label: 'disk',
	contractVersion: 1,
	capabilities: { claims: true, listing: true, multiTenant: false },
	// The disk store is the one a host actually gets, and the only one whose
	// arbitration has to survive leaving the process.
	makeStore: async (binding) => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-claim-'))
		return {
			store: new DiskCheckpointStore({ baseDir: dir }, binding),
			dispose: () => removeTempDirAsync(dir),
		}
	},
})

describe('the two shipped stores, side by side', () => {
	/**
	 * Not in the conformance suite, and deliberately.
	 *
	 * The published contract promises fences are monotonic and unique. It does
	 * NOT promise particular numbers, and it must not: a host backing this with
	 * a database sequence gets gaps for free, and a suite that failed such a
	 * backend would be enforcing an implementation detail of two filesystems.
	 *
	 * Inside this repository the exact numbering IS a claim, though — the
	 * in-memory store's source says a released run's next claim is `fence + 2`
	 * "in both stores, because the tombstone consumed one. That is parity, not
	 * an off-by-one." A mutation that moved the disk tombstone to `fence + 2`
	 * (making the next claim `fence + 3`) killed no test at all, so that
	 * sentence was undriven. This is the one that drives it.
	 */
	it('numbers a released run’s next claim identically', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-parity-'))
		try {
			const stores: CheckpointStore[] = [
				new InMemoryCheckpointStore(),
				new DiskCheckpointStore(
					{ baseDir: dir },
					{
						tenantId: 'tnt_claim' as TenantId,
						projectId: 'prj_claim' as ProjectId,
						sessionId: 'ses_claim' as SessionId,
					},
				),
			]

			const nextFences: number[] = []
			for (const store of stores) {
				const first = await claimRun(store, scope('run_parity'), {
					holder: 'w1',
					ttlMs: 60_000,
					now: 1,
				})
				await releaseRun(store, scope('run_parity'), first?.fence as number)
				const second = await claimRun(store, scope('run_parity'), {
					holder: 'w2',
					ttlMs: 60_000,
					now: 2,
				})
				expect(first?.fence).toBe(1)
				nextFences.push(second?.fence as number)
			}

			// The tombstone consumed exactly one number, in both.
			expect(nextFences).toEqual([3, 3])
		} finally {
			await removeTempDirAsync(dir)
		}
	})

	it('is the revision this build ships', () => {
		// The two calls above hard-code `1`, which is the point of the check
		// they feed. Nothing else in the repository would notice the constant
		// moving without them — and a bumped constant with unbumped callers is
		// a `major` that shipped as a `minor`.
		expect(CHECKPOINT_STORE_CONTRACT_VERSION).toBe(1)
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
		await expect(claimRun(cannot, scope('run_a'), { holder: 'w1', ttlMs: 1_000 })).rejects.toThrow(
			/does not implement `claimRun`/,
		)
	})

	it('refuses to release rather than pretending it did', async () => {
		await expect(releaseRun(cannot, scope('run_a'), 1)).rejects.toThrow(
			/does not implement `releaseRun`/,
		)
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
