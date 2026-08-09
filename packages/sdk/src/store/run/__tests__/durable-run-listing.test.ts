import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import { findPendingCheckpoint } from '../../../runtime/query/checkpoint.js'
import type { HITLDecisionRequest, IterationCheckpoint } from '../../../types/hitl/index.js'
import type {
	CheckpointId,
	ProjectId,
	RunId,
	SessionId,
	TenantId,
} from '../../../types/ids/index.js'
import type {
	CheckpointListingScope,
	CheckpointRunScope,
	CheckpointStore,
	DurableRunEntry,
} from '../../../types/run/checkpoint-store.js'
import { DiskCheckpointStore } from '../checkpoint-disk.js'
import { InMemoryCheckpointStore } from '../checkpoint-memory.js'
import { listDurableRuns } from '../listing.js'

/**
 * The kernel could write a park at any delegation depth and resume it from
 * another process, and could not answer "which runs are waiting on a human"
 * — every durable read needed a `runId` the asker did not have. These tests
 * are about the read that closes that, and about the three ways a listing
 * quietly lies: by reordering under a paging caller, by omitting sub-runs,
 * and by reporting an empty page when it means "I cannot tell".
 */

const T1 = 'tnt_one' as TenantId
const T2 = 'tnt_two' as TenantId
const P1 = 'prj_one' as ProjectId
const S1 = 'ses_one' as SessionId

function scope(runId: string, over: Partial<CheckpointRunScope> = {}): CheckpointRunScope {
	return {
		tenantId: T1,
		projectId: P1,
		sessionId: S1,
		runId: runId as RunId,
		...over,
	}
}

let cpSeq = 0

/**
 * A checkpoint whose budget fields are all present.
 *
 * The disk store REFUSES a checkpoint with malformed budgets rather than
 * resuming from it, so a fixture that omitted them would test the refusal
 * path in every case and none of the listing. Fixture-must-match-production
 * applies here literally: this is the shape the manager writes.
 */
function checkpoint(
	runId: string,
	createdAt: number,
	pending?: IterationCheckpoint['pending'],
	runCreatedAt?: number,
): IterationCheckpoint {
	cpSeq += 1
	return {
		id: `cp_${cpSeq}` as CheckpointId,
		runId: runId as RunId,
		...(runCreatedAt !== undefined ? { runCreatedAt } : {}),
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
		createdAt,
		...(pending ? { pending } : {}),
	}
}

function request(runId: string): HITLDecisionRequest {
	return {
		type: 'tool_review',
		runId: runId as RunId,
		checkpointId: 'cp_placeholder' as CheckpointId,
		toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
	}
}

const NOW = 1_000_000

/** A park nobody has answered and whose window is still open. */
function outstanding(runId: string): IterationCheckpoint['pending'] {
	return { request: request(runId), parkedAt: NOW - 1_000, deadlineAt: NOW + 10_000 }
}

/** A park nobody answered before its window closed. */
function expired(runId: string): IterationCheckpoint['pending'] {
	return { request: request(runId), parkedAt: NOW - 10_000, deadlineAt: NOW - 1 }
}

/** A park a human answered. */
function resolved(runId: string, at = NOW - 500): IterationCheckpoint['pending'] {
	return {
		request: request(runId),
		parkedAt: NOW - 2_000,
		resolvedAt: at,
		decision: { action: 'approve_tools' },
	}
}

const ALL: CheckpointListingScope = { tenantId: T1 }

/**
 * Page a listing to exhaustion, refusing to page forever.
 *
 * Every one of these walks was `while (cursor !== undefined)` with nothing
 * stopping it, and a mutation that made the cursor a no-op turned three
 * tests from red into a HANG. That is strictly worse than a failure: a
 * stalled suite reads as flaky infrastructure and gets retried, where a
 * failure names the defect. The bound is generous enough that no correct
 * implementation reaches it and tight enough that a broken cursor is
 * reported as what it is.
 */
async function walk(
	store: CheckpointStore,
	options: Parameters<typeof listDurableRuns>[2],
): Promise<string[]> {
	const seen: string[] = []
	let cursor: string | undefined
	for (let page = 0; page <= 20; page++) {
		if (page === 20) throw new Error('walk: cursor never exhausted — the listing is paging forever')
		const result = await listDurableRuns(store, ALL, { ...options, cursor })
		seen.push(...result.entries.map((e) => e.runId))
		cursor = result.cursor
		if (cursor === undefined) return seen
	}
	return seen
}

// ── the acceptance case ──────────────────────────────────────────────────

describe('an approval inbox, through an injected store', () => {
	it('enumerates exactly one tenant’s parked runs, sub-run included', async () => {
		const store = new InMemoryCheckpointStore()

		// Three parked runs across two tenants, one of them a SUB-run —
		// which is the case the only pre-existing listing skipped outright.
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))
		await store.writeCheckpoint(
			scope('run_b', { parentRunId: 'run_a' as RunId }),
			checkpoint('run_b', 2, outstanding('run_b')),
		)
		await store.writeCheckpoint(
			scope('run_c', { tenantId: T2 }),
			checkpoint('run_c', 3, outstanding('run_c')),
		)
		// …and a run of the same tenant that is not parked at all.
		await store.writeCheckpoint(scope('run_d'), checkpoint('run_d', 4))

		const page = await listDurableRuns(store, ALL, { park: ['outstanding'], now: NOW })

		expect(page.entries.map((e) => e.runId)).toEqual(['run_a', 'run_b'])
		// A row that cannot name its parent cannot be addressed, and a
		// sub-run's checkpoints live under its parent.
		expect(page.entries[1]?.parentRunId).toBe('run_a')
		expect(page.entries[0]?.parentRunId).toBeUndefined()
	})

	it('narrows to a project and to a session, not only to a tenant', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1))
		await store.writeCheckpoint(
			scope('run_b', { projectId: 'prj_other' as ProjectId }),
			checkpoint('run_b', 2),
		)
		await store.writeCheckpoint(
			scope('run_c', { sessionId: 'ses_other' as SessionId }),
			checkpoint('run_c', 3),
		)

		// One tenant can hold many projects and one project many sessions. A
		// store that answered every narrowing with the tenant's whole set
		// would look right against a single-session fixture and hand an
		// operator another team's queue in production.
		expect(
			(await listDurableRuns(store, { tenantId: T1, projectId: P1 }, { now: NOW })).entries.map(
				(e) => e.runId,
			),
		).toEqual(['run_a', 'run_c'])
		expect(
			(
				await listDurableRuns(store, { tenantId: T1, projectId: P1, sessionId: S1 }, { now: NOW })
			).entries.map((e) => e.runId),
		).toEqual(['run_a'])
	})

	it('hands a row straight back to the read that answers it', async () => {
		const store = new InMemoryCheckpointStore()
		const cp = checkpoint('run_a', 1, outstanding('run_a'))
		await store.writeCheckpoint(scope('run_a'), cp)

		const page = await listDurableRuns(store, ALL, { park: ['outstanding'], now: NOW })
		const entry = page.entries[0] as DurableRunEntry

		// An entry IS a run scope. If it were not, every caller would
		// re-assemble one from loose fields and eventually assemble it wrong.
		expect((await findPendingCheckpoint(store, entry, { now: NOW }))?.id).toBe(cp.id)
		expect(entry.park?.checkpointId).toBe(cp.id)
		expect(entry.park?.requestType).toBe('tool_review')
	})

	it('agrees with findPendingCheckpoint about which runs are outstanding', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))
		await store.writeCheckpoint(scope('run_b'), checkpoint('run_b', 2, expired('run_b')))
		await store.writeCheckpoint(scope('run_c'), checkpoint('run_c', 3, resolved('run_c')))
		await store.writeCheckpoint(scope('run_d'), checkpoint('run_d', 4))

		const all = await listDurableRuns(store, ALL, { now: NOW })

		// Two answers to "is this run waiting on a human" is one answer too
		// many; the inbox and the resume path have to see the same run set.
		for (const entry of all.entries) {
			const pending = await findPendingCheckpoint(store, entry, { now: NOW })
			expect(pending !== null).toBe(entry.park?.state === 'outstanding')
		}
		expect(all.entries.map((e) => e.park?.state)).toEqual([
			'outstanding',
			'expired',
			'resolved',
			undefined,
		])
	})
})

// ── park state ───────────────────────────────────────────────────────────

describe('park state', () => {
	let store: InMemoryCheckpointStore

	beforeEach(() => {
		store = new InMemoryCheckpointStore()
	})

	it('separates the sweep queue from the inbox queue', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))
		await store.writeCheckpoint(scope('run_b'), checkpoint('run_b', 2, expired('run_b')))

		// `hitlParkTtlMs` documents a host sweep as the reclamation path.
		// This is the enumeration that sweep never had.
		const sweep = await listDurableRuns(store, ALL, { park: ['expired'], now: NOW })
		expect(sweep.entries.map((e) => e.runId)).toEqual(['run_b'])

		const inbox = await listDurableRuns(store, ALL, { park: ['outstanding'], now: NOW })
		expect(inbox.entries.map((e) => e.runId)).toEqual(['run_a'])
	})

	it('reads an answer given after the deadline as answered, not as expired', async () => {
		// The checkpoint is the evidence record for who decided what.
		// Reporting a decision a human actually made as an expiry nobody made
		// destroys exactly the fact it exists to keep.
		await store.writeCheckpoint(
			scope('run_a'),
			checkpoint('run_a', 1, {
				request: request('run_a'),
				parkedAt: NOW - 10_000,
				deadlineAt: NOW - 5_000,
				resolvedAt: NOW - 4_000,
				decision: { action: 'approve_tools' },
			}),
		)

		const page = await listDurableRuns(store, ALL, { now: NOW })
		expect(page.entries[0]?.park?.state).toBe('resolved')
	})

	it('reports a live park even when a resolved one is newer', async () => {
		// Ranking by recency alone gets this wrong: an earlier park that
		// expired unanswered can outlive a later one that was answered, and
		// an inbox that took the newest would report the live park as
		// nothing.
		await store.writeCheckpoint(
			scope('run_a'),
			checkpoint('run_a', 1, {
				request: request('run_a'),
				parkedAt: NOW - 9_000,
				deadlineAt: NOW + 10_000,
			}),
		)
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 2, resolved('run_a')))

		const page = await listDurableRuns(store, ALL, { park: ['outstanding'], now: NOW })
		expect(page.entries).toHaveLength(1)
		expect(page.entries[0]?.park?.parkedAt).toBe(NOW - 9_000)
	})

	it('prefers the newest of two outstanding parks', async () => {
		await store.writeCheckpoint(
			scope('run_a'),
			checkpoint('run_a', 1, {
				request: request('run_a'),
				parkedAt: NOW - 9_000,
				deadlineAt: NOW + 1_000,
			}),
		)
		await store.writeCheckpoint(
			scope('run_a'),
			checkpoint('run_a', 2, {
				request: request('run_a'),
				parkedAt: NOW - 100,
				deadlineAt: NOW + 1_000,
			}),
		)

		const page = await listDurableRuns(store, ALL, { now: NOW })
		expect(page.entries[0]?.park?.parkedAt).toBe(NOW - 100)
	})

	it('judges expiry against the supplied clock, not the wall clock', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))

		expect(
			(await listDurableRuns(store, ALL, { park: ['outstanding'], now: NOW })).entries,
		).toHaveLength(1)
		expect(
			(await listDurableRuns(store, ALL, { park: ['expired'], now: NOW + 10 ** 9 })).entries,
		).toHaveLength(1)
	})
})

// ── ordering and paging ──────────────────────────────────────────────────

describe('paging', () => {
	const ids = ['run_e', 'run_a', 'run_d', 'run_b', 'run_c']

	async function seed(): Promise<InMemoryCheckpointStore> {
		const store = new InMemoryCheckpointStore()
		for (const [i, id] of ids.entries()) {
			await store.writeCheckpoint(scope(id), checkpoint(id, 100 - i))
		}
		return store
	}

	it('walks every run exactly once and then stops', async () => {
		const store = await seed()
		expect(await walk(store, { limit: 2, now: NOW })).toEqual([
			'run_a',
			'run_b',
			'run_c',
			'run_d',
			'run_e',
		])
	})

	it('withholds the cursor on the page that exhausts the listing', async () => {
		const store = await seed()

		// Asserting only that the walk terminates does not distinguish this
		// from a store that hands out one more cursor and answers it with an
		// empty page. It terminates either way; a mutation removing the
		// exhaustion check survived that test. The contract says a store never
		// returns a cursor it already knows yields nothing, so assert the
		// last page directly.
		//
		// Cursors are carried opaquely here on purpose — a test that spelled
		// one out would be a test of the encoding, and the contract says the
		// shape is not part of it.
		const first = await listDurableRuns(store, ALL, { limit: 3, now: NOW })
		expect(first.cursor).toBeDefined()

		const last = await listDurableRuns(store, ALL, { limit: 2, cursor: first.cursor, now: NOW })
		expect(last.entries.map((e) => e.runId)).toEqual(['run_d', 'run_e'])
		expect(last.cursor).toBeUndefined()

		// And a page that fills exactly, with more behind it, still carries one.
		const middle = await listDurableRuns(store, ALL, { limit: 2, now: NOW })
		expect(middle.entries.map((e) => e.runId)).toEqual(['run_a', 'run_b'])
		expect(middle.cursor).toBeDefined()
	})

	it('does not lose or repeat a run when the sort key would have moved', async () => {
		const store = await seed()

		const first = await listDurableRuns(store, ALL, { limit: 2, now: NOW })
		expect(first.entries.map((e) => e.runId)).toEqual(['run_a', 'run_b'])

		// `run_a` checkpoints again between pages. Ordered by any timestamp
		// this store can derive, it would jump the queue and shove a run past
		// the cursor — silently dropping it from a sweep.
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 10_000))

		expect(await walk(store, { limit: 2, now: NOW })).toEqual([
			'run_a',
			'run_b',
			'run_c',
			'run_d',
			'run_e',
		])
	})

	it('clamps a nonsense limit rather than returning nothing', async () => {
		const store = await seed()
		const page = await listDurableRuns(store, ALL, { limit: 0, now: NOW })
		// A limit of zero that returned an empty page would read as "no runs
		// are parked" — the failure this whole listing exists to avoid.
		expect(page.entries.map((e) => e.runId)).toEqual(['run_a'])

		const next = await listDurableRuns(store, ALL, { limit: 0, cursor: page.cursor, now: NOW })
		expect(next.entries.map((e) => e.runId)).toEqual(['run_b'])
	})
})

// ── the creation stamp, and the order it makes possible ──────────────────

describe('ordering by when the run was attributed', () => {
	/** Seeded so that id order and creation order disagree completely. */
	async function seed(): Promise<InMemoryCheckpointStore> {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 50, undefined, 500))
		await store.writeCheckpoint(scope('run_b'), checkpoint('run_b', 50, undefined, 400))
		await store.writeCheckpoint(scope('run_c'), checkpoint('run_c', 50, undefined, 300))
		return store
	}

	it('answers which run has been waiting longest', async () => {
		const store = await seed()

		// Run ids carry no timestamp, so id order says nothing about age. An
		// operator triaging an inbox asks for the oldest, and until there was
		// a key that did not move, that question had no answer.
		expect(
			(await listDurableRuns(store, ALL, { orderBy: 'createdAt', now: NOW })).entries.map(
				(e) => e.runId,
			),
		).toEqual(['run_c', 'run_b', 'run_a'])
	})

	it('leaves the default alone', async () => {
		const store = await seed()
		// Changing the default order would be a changed default, and a caller
		// paging today would silently start walking a different sequence.
		expect((await listDurableRuns(store, ALL, { now: NOW })).entries.map((e) => e.runId)).toEqual([
			'run_a',
			'run_b',
			'run_c',
		])
	})

	it('pages oldest-first without losing a run that checkpoints again', async () => {
		const store = await seed()

		const first = await listDurableRuns(store, ALL, { orderBy: 'createdAt', limit: 1, now: NOW })
		expect(first.entries.map((e) => e.runId)).toEqual(['run_c'])

		// The oldest run checkpoints again mid-pagination. This is the exact
		// move that breaks a listing sorted on `latestCheckpointAt`; the
		// attribution stamp does not move, so the walk is unaffected.
		await store.writeCheckpoint(scope('run_c'), checkpoint('run_c', 9_000, undefined, 300))

		expect(await walk(store, { orderBy: 'createdAt', limit: 1, now: NOW })).toEqual([
			'run_c',
			'run_b',
			'run_a',
		])
	})

	it('does not move when the oldest checkpoint is pruned away', async () => {
		const store = new InMemoryCheckpointStore()
		const first = checkpoint('run_a', 10, undefined, 300)
		const second = checkpoint('run_a', 20, undefined, 300)
		await store.writeCheckpoint(scope('run_a'), first)
		await store.writeCheckpoint(scope('run_a'), second)

		// Pruning deletes oldest-first, which is what disqualified every other
		// timestamp. The stamp is on every checkpoint, so pruning cannot reach
		// a value the survivors also hold.
		await store.deleteCheckpoint(scope('run_a'), first.id)

		const page = await listDurableRuns(store, ALL, { orderBy: 'createdAt', now: NOW })
		expect(page.entries[0]?.runCreatedAt).toBe(300)
	})

	it('puts runs whose creation was never recorded first, and says so on the row', async () => {
		const store = await seed()
		await store.writeCheckpoint(scope('run_z'), checkpoint('run_z', 60))
		await store.writeCheckpoint(scope('run_y'), checkpoint('run_y', 60))

		const page = await listDurableRuns(store, ALL, { orderBy: 'createdAt', now: NOW })

		// Not a guess dressed up as a date: the stamp is written by the
		// checkpoint manager, so a run without one was checkpointed by a build
		// that predates the stamp — and therefore predates every run that has
		// one. `runCreatedAt` stays absent so a caller renders "unknown"
		// rather than a time nobody recorded.
		expect(page.entries.map((e) => e.runId)).toEqual(['run_y', 'run_z', 'run_c', 'run_b', 'run_a'])
		expect(page.entries[0]?.runCreatedAt).toBeUndefined()
		expect(page.entries[2]?.runCreatedAt).toBe(300)
	})

	it('tells "not recorded" apart from "recorded as the epoch"', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 10, undefined, 0))
		await store.writeCheckpoint(scope('run_z'), checkpoint('run_z', 10))

		// Zero is a recorded time; absence is not a time at all. Ordering by a
		// timestamp alone would collapse the two and interleave them by id —
		// which is why the sort key ranks "unrecorded" as a position of its
		// own rather than standing a number in for it.
		const page = await listDurableRuns(store, ALL, { orderBy: 'createdAt', now: NOW })
		expect(page.entries.map((e) => [e.runId, e.runCreatedAt])).toEqual([
			['run_z', undefined],
			['run_a', 0],
		])
	})

	it('pages across the boundary between unrecorded and recorded runs', async () => {
		const store = await seed()
		await store.writeCheckpoint(scope('run_z'), checkpoint('run_z', 60))

		// The cursor has to carry the rank as well as the time, or the first
		// stamped row compares against a stand-in timestamp and the walk
		// either repeats the unrecorded runs or skips the oldest recorded one.
		expect(await walk(store, { orderBy: 'createdAt', limit: 1, now: NOW })).toEqual([
			'run_z',
			'run_c',
			'run_b',
			'run_a',
		])
	})

	it('refuses a cursor it did not issue', async () => {
		const store = await seed()
		// A caller constructing a cursor is a caller depending on a shape that
		// is not part of the contract. Refusing beats silently treating it as
		// a position and returning a page from nowhere.
		await expect(
			listDurableRuns(store, ALL, { orderBy: 'createdAt', cursor: 'run_c', now: NOW }),
		).rejects.toThrow(/not a cursor this listing issued/)
	})
})

// ── refusals ─────────────────────────────────────────────────────────────

describe('what it refuses to answer', () => {
	it('refuses a store that cannot list, rather than reporting an empty inbox', async () => {
		const cannot: CheckpointStore = {
			writeCheckpoint: async () => {},
			readCheckpoint: async () => null,
			listCheckpoints: async () => [],
			deleteCheckpoint: async () => {},
		}

		// "Nothing is waiting on a human" is not what "I cannot tell" means,
		// and an inbox built on the first answer never fires.
		await expect(listDurableRuns(cannot, ALL)).rejects.toThrow(/does not implement/)
	})

	it('refuses a listing scope with a hole in it', async () => {
		const store = new InMemoryCheckpointStore()
		// A flat backend can answer "that session under whichever project
		// holds it" and a hierarchical one cannot. An answer that depends on
		// the backend's storage shape is not a contract.
		await expect(
			listDurableRuns(store, { tenantId: T1, sessionId: S1 } as CheckpointListingScope),
		).rejects.toThrow(/contiguous prefix/)
	})

	it('refuses the hole even when the store below would have answered', async () => {
		// The shipped stores validate too, so removing the helper's own check
		// changed nothing observable — a mutation that killed no test. The
		// helper's check is the backstop for a HOST-supplied store, and a
		// backstop only two compliant stores stand behind is untested by
		// construction. This is a store that does not validate.
		const permissive: CheckpointStore = {
			writeCheckpoint: async () => {},
			readCheckpoint: async () => null,
			listCheckpoints: async () => [],
			deleteCheckpoint: async () => {},
			listDurableRuns: async () => ({ entries: [] }),
		}

		await expect(
			listDurableRuns(permissive, { tenantId: T1, sessionId: S1 } as CheckpointListingScope),
		).rejects.toThrow(/contiguous prefix/)
	})
})

// ── the disk store ───────────────────────────────────────────────────────

describe('the disk store', () => {
	let dir: string
	let store: DiskCheckpointStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-listing-'))
		store = new DiskCheckpointStore(
			{ baseDir: dir },
			{ tenantId: T1, projectId: P1, sessionId: S1 },
		)
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	it('finds a run, its child and its grandchild, each with the right parent', async () => {
		// `initRun` nests exactly one level at every depth, so a grandchild
		// sits beside the top-level runs rather than beneath its grandparent.
		// A walk that assumed a growing tree would miss it.
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))
		await store.writeCheckpoint(
			scope('run_b', { parentRunId: 'run_a' as RunId }),
			checkpoint('run_b', 2, outstanding('run_b')),
		)
		await store.writeCheckpoint(
			scope('run_c', { parentRunId: 'run_b' as RunId }),
			checkpoint('run_c', 3, outstanding('run_c')),
		)

		const page = await listDurableRuns(store, ALL, { now: NOW })

		expect(page.entries.map((e) => [e.runId, e.parentRunId])).toEqual([
			['run_a', undefined],
			['run_b', 'run_a'],
			['run_c', 'run_b'],
		])
	})

	it('does not report the empty shell directory a nested run leaves behind', async () => {
		await store.writeCheckpoint(
			scope('run_b', { parentRunId: 'run_a' as RunId }),
			checkpoint('run_b', 1),
		)

		// `mkdir -p` created `<dir>/run_a/children/run_b`, so `run_a` exists
		// as a directory holding nothing. A run with no durable state is not
		// something a sweeper could resume.
		const page = await listDurableRuns(store, ALL, { now: NOW })
		expect(page.entries.map((e) => e.runId)).toEqual(['run_b'])
	})

	it('does not create a directory for a run it merely looked at', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1))
		const before = await listDurableRuns(store, ALL, { now: NOW })
		const after = await listDurableRuns(store, ALL, { now: NOW })
		// Binding a per-run store would `mkdir` the run directory, so a
		// listing would grow the tree it is reporting on.
		expect(after.entries.map((e) => e.runId)).toEqual(before.entries.map((e) => e.runId))
	})

	it('reports another tenant as empty rather than as an isolation failure', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1))
		// The caller asked a scoped question, not for a specific record —
		// the same reasoning `listSessions` already states for sessions that
		// share a thread id across tenants.
		expect((await listDurableRuns(store, { tenantId: T2 }, { now: NOW })).entries).toEqual([])
		expect(
			(await listDurableRuns(store, { tenantId: T1, projectId: 'prj_other' as ProjectId })).entries,
		).toEqual([])
	})

	it('refuses to list when it was never told what tree it holds', async () => {
		const anonymous = new DiskCheckpointStore({ baseDir: dir })
		await anonymous.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1))
		// A row stamped with a guessed tenant is a row a sweeper would resume
		// under the wrong isolation boundary.
		await expect(listDurableRuns(anonymous, ALL)).rejects.toThrow(/without attribution/)
	})

	it('refuses the whole listing when a checkpoint file is damaged', async () => {
		await store.writeCheckpoint(scope('run_a'), checkpoint('run_a', 1, outstanding('run_a')))
		await writeFile(join(dir, 'run_a', 'checkpoints', 'cp_broken.json'), '{}', 'utf-8')

		// A damaged file that dropped the run from the listing is the
		// missing-park failure one level up: an approval a human is owed,
		// invisible, with nothing reported.
		await expect(listDurableRuns(store, ALL, { now: NOW })).rejects.toThrow(/not a usable/)
	})

	it('reads back the same runs the in-memory store does', async () => {
		const memory = new InMemoryCheckpointStore()
		const rows: [CheckpointRunScope, IterationCheckpoint][] = [
			[scope('run_a'), checkpoint('run_a', 1, outstanding('run_a'))],
			[scope('run_b', { parentRunId: 'run_a' as RunId }), checkpoint('run_b', 2, expired('run_b'))],
			[scope('run_c'), checkpoint('run_c', 3)],
		]
		for (const [s, cp] of rows) {
			await store.writeCheckpoint(s, cp)
			await memory.writeCheckpoint(s, cp)
		}

		const project = (entries: readonly DurableRunEntry[]) =>
			entries.map((e) => [e.runId, e.parentRunId, e.park?.state, e.latestCheckpointAt])

		// A backend that diverges from the built-in one is worse than no
		// backend: the host tests against one and ships the other.
		expect(project((await listDurableRuns(store, ALL, { now: NOW })).entries)).toEqual(
			project((await listDurableRuns(memory, ALL, { now: NOW })).entries),
		)
	})
})
