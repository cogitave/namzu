import { describe, expect, it } from 'vitest'

import type { RunPersistence } from '../../../manager/run/persistence.js'
import {
	CheckpointManager,
	projectEmergencyToCheckpoint,
} from '../../../runtime/query/checkpoint.js'
import type { ProjectId, RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import { InMemoryCheckpointStore } from '../checkpoint-memory.js'
import { listDurableRuns, toDurableRunEntry } from '../listing.js'

/**
 * The listing needs a per-run key that does not move, and the only way to
 * have one is to record it once and never rewrite it. These tests are about
 * the "never rewrite" half, because that is the half a later edit destroys
 * silently: a stamp that is merely usually stable reads exactly like one
 * that is stable, right up until a paging caller loses a run.
 */

const T1 = 'tnt_stamp' as TenantId
const P1 = 'prj_stamp' as ProjectId
const S1 = 'ses_stamp' as SessionId

function scope(runId: string): CheckpointRunScope {
	return { tenantId: T1, projectId: P1, sessionId: S1, runId: runId as RunId }
}

/** A run manager stub carrying the six fields `create` actually reads. */
function runMgr(runId: string, startedAt: number): RunPersistence {
	return {
		id: runId as RunId,
		messages: [],
		currentIteration: 1,
		tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		costInfo: { totalCost: 0 },
		getSession: () => ({ startedAt }),
	} as unknown as RunPersistence
}

describe('the run attribution stamp', () => {
	it('is the run’s own start, not the clock at the first checkpoint', async () => {
		const store = new InMemoryCheckpointStore()
		const manager = new CheckpointManager(store, scope('run_a'))

		const cp = await manager.create(runMgr('run_a', 1_000), 1)

		// Taking `Date.now()` here would record when the run first became
		// DURABLE, which is a different and later fact than when it was
		// attributed — and naming it after the earlier one is the kind of
		// wrong that never looks wrong.
		expect(cp.runCreatedAt).toBe(1_000)
		expect(cp.createdAt).not.toBe(1_000)
	})

	it('is identical on every checkpoint of the run, even if the run’s clock moves', async () => {
		const store = new InMemoryCheckpointStore()
		const manager = new CheckpointManager(store, scope('run_a'))

		const first = await manager.create(runMgr('run_a', 1_000), 1)
		// A second manager call whose run object reports a different start.
		// Nothing in the SDK does this today, and the field's whole value is
		// that nothing ever can.
		const second = await manager.create(runMgr('run_a', 9_999), 2)

		expect(second.runCreatedAt).toBe(first.runCreatedAt)
	})

	it('survives a resume in a new process', async () => {
		const store = new InMemoryCheckpointStore()
		const original = await new CheckpointManager(store, scope('run_a')).create(
			runMgr('run_a', 1_000),
			1,
		)

		// A resumed run is the same run under the same id, but a fresh
		// `RunPersistence` mints a fresh start instant. Without the adopt, the
		// stamp would step forward on every resume — the exact motion it
		// exists to avoid.
		const resumed = new CheckpointManager(store, scope('run_a'))
		await resumed.restore(original.id)
		const next = await resumed.create(runMgr('run_a', 8_000), 2)

		expect(next.runCreatedAt).toBe(1_000)

		const page = await listDurableRuns(store, { tenantId: T1 })
		expect(page.entries[0]?.runCreatedAt).toBe(1_000)
	})

	it('is not inherited by a replay fork, which is a new run', async () => {
		const store = new InMemoryCheckpointStore()
		await new CheckpointManager(store, scope('run_a')).create(runMgr('run_a', 1_000), 1)

		// A fork reads its origin through the SOURCE run's scope, inside
		// `prepareReplayState`, and then starts a fresh run — so its own
		// manager restores nothing and mints. Inheriting would have a run
		// minted a minute ago claim its origin's age and sit at the top of an
		// operator's oldest-first queue.
		//
		// The first draft of this test called `fork.restore(originCheckpoint)`
		// and it threw `not_found`, which is the proof: a manager can only
		// read checkpoints under its own run id, so a fork could not inherit
		// even if the code tried to let it.
		const fork = new CheckpointManager(store, scope('run_fork'))
		const forked = await fork.create(runMgr('run_fork', 7_000), 1)

		expect(forked.runCreatedAt).toBe(7_000)

		const page = await listDurableRuns(store, { tenantId: T1 }, { orderBy: 'createdAt' })
		expect(page.entries.map((e) => e.runId)).toEqual(['run_a', 'run_fork'])
	})

	it('reads as the earliest recorded value across a run’s checkpoints', async () => {
		// Defensive rather than expected: every checkpoint of a run carries
		// the same value, so the minimum IS that value. Taking the minimum is
		// what makes the read unable to move when a later checkpoint is added,
		// even if some future writer breaks the invariant.
		const entry = toDurableRunEntry(
			scope('run_a'),
			[
				{ ...base('cp_1', 10), runCreatedAt: 500 },
				{ ...base('cp_2', 20), runCreatedAt: 900 },
				base('cp_3', 30),
			],
			0,
		)

		expect(entry?.runCreatedAt).toBe(500)
	})

	it('survives every write the manager makes, not just the first', async () => {
		// The stamp is only a stable sort key if EVERY producer carries it. The
		// docs gate caught this: touching the checkpoint type made the
		// one-site-is-not-every-site rule stale, and that rule is precisely
		// "which callers arrive here", not "does this exist". Enumerating the
		// producers found five — `create`, `park`, `expire`, `unpark` and the
		// emergency projection — and this pins four of them. A park that
		// dropped the stamp would take its run out of the oldest-first inbox
		// at the exact moment the run entered it.
		const store = new InMemoryCheckpointStore()
		const manager = new CheckpointManager(store, scope('run_a'))

		const created = await manager.create(runMgr('run_a', 1_000), 1)
		const parked = await manager.park(created, {
			type: 'plan_approval',
			runId: 'run_a' as RunId,
			checkpointId: created.id,
			plan: { steps: [] } as never,
		})
		const resolved = await manager.unpark(parked.id, { action: 'approve_plan' })

		const second = await manager.create(runMgr('run_a', 1_000), 2)
		const parkedAgain = await manager.park(second, {
			type: 'plan_approval',
			runId: 'run_a' as RunId,
			checkpointId: second.id,
			plan: { steps: [] } as never,
		})
		const expired = await manager.expire(parkedAgain.id)

		expect([parked, resolved, expired].map((c) => c?.runCreatedAt)).toEqual([1_000, 1_000, 1_000])
	})

	it('is carried by an emergency dump’s projection', async () => {
		// A run whose only surviving record is an emergency dump still has a
		// real attribution instant — the dump records it. Dropping it here
		// would put that run in the "never recorded" bucket for no reason, and
		// a crashed run is exactly the one an operator is looking for.
		const projected = projectEmergencyToCheckpoint({
			id: 'esave_x',
			runId: 'run_a' as RunId,
			currentIteration: 3,
			messages: [],
			tokenUsage: {
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			startedAt: 1_000,
			savedAt: 4_000,
		} as never)

		expect(projected.runCreatedAt).toBe(1_000)
	})

	it('is absent, not zero, when nothing recorded it', async () => {
		const entry = toDurableRunEntry(scope('run_a'), [base('cp_1', 10)], 0)
		// Zero is a date. "Not recorded" is not, and a caller has to be able
		// to tell them apart to render one of them honestly.
		expect(entry?.runCreatedAt).toBeUndefined()
		expect('runCreatedAt' in (entry ?? {})).toBe(false)
	})
})

function base(id: string, createdAt: number) {
	return {
		id: id as never,
		runId: 'run_a' as RunId,
		iteration: 1,
		messages: [],
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 } as never,
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt,
	}
}
