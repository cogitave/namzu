import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { ProjectId, RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import { DiskCheckpointStore } from '../checkpoint-disk.js'
import { acquireClaim, currentFence, readClaim, releaseClaim } from '../claim-disk.js'
import { listDurableRuns } from '../listing.js'

/**
 * Four defects an adversarial review reproduced from separate OS processes,
 * every one of which survived thirteen well-aimed mutations.
 *
 * They survived because a mutation table is evidence about the paths the
 * tests reach, and the branch none of them reached — a stale lock being
 * broken by two workers at once — is where all four lived. One test per
 * defect, at the level the defect lives, so a change that reintroduces any of
 * them fails here rather than probabilistically on a loaded machine.
 */

const T1 = 'tnt_reg' as TenantId
const P1 = 'prj_reg' as ProjectId
const S1 = 'ses_reg' as SessionId

function scope(runId = 'run_a'): CheckpointRunScope {
	return { tenantId: T1, projectId: P1, sessionId: S1, runId: runId as RunId }
}

function checkpoint(id: string): IterationCheckpoint {
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
		costInfo: { totalCost: 0 } as IterationCheckpoint['costInfo'],
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: 1,
	}
}

describe('claim regressions', () => {
	let dir: string
	let runDir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-reg-'))
		runDir = join(dir, 'run_a')
		await mkdir(runDir, { recursive: true })
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	it('never issues one fence twice, however many takers race', async () => {
		// The defect: a stale-lock breaker that unlinked and then created, so
		// two workers could both end up inside the serialized section, both
		// re-read the same expired claim, and both compute the SAME fence.
		// An identical fence fences nobody out, because the check is `<`.
		const takers = await Promise.all(
			Array.from({ length: 32 }, (_, i) =>
				acquireClaim(runDir, { holder: `w${i}`, ttlMs: 60_000, now: 1_000 }),
			),
		)

		const issued = takers.filter((c) => c !== null).map((c) => c?.fence)
		expect(new Set(issued).size).toBe(issued.length)
		// And exactly one caller can hold a free run at one instant.
		expect(issued).toHaveLength(1)
	})

	it('never rewinds the fence, however often a holder releases', async () => {
		// The defect: releasing DELETED the claim, so the next take went down
		// the fresh path and minted fence 1 again — and the documented
		// `finally { releaseRun() }` did it every pass. A worker stalled at
		// fence 1 could then write alongside a new holder also at fence 1.
		const seen: number[] = []
		for (let i = 0; i < 5; i++) {
			const claim = await acquireClaim(runDir, {
				holder: `w${i}`,
				ttlMs: 60_000,
				now: 1_000 + i,
			})
			expect(claim).not.toBeNull()
			seen.push(claim?.fence as number)
			await releaseClaim(runDir, claim?.fence as number)
		}

		expect(seen).toEqual([...seen].sort((a, b) => a - b))
		expect(new Set(seen).size).toBe(seen.length)
		expect(seen[0]).toBeLessThan(seen[seen.length - 1] as number)
	})

	it('is still claimable when a holding body cannot be read', async () => {
		// The defect: an unparseable claim made every future acquire return
		// `null` forever — the reviewer verified it at +1 year — and the
		// caller could not tell, because `null` is also the ordinary
		// "somebody else got there first". Reachable because a non-atomic
		// create leaves a zero-byte file after a crash or a full disk.
		await mkdir(join(runDir, 'claims'), { recursive: true })
		await writeFile(join(runDir, 'claims', '4.json'), '', 'utf-8')

		const claim = await acquireClaim(runDir, {
			holder: 'w1',
			ttlMs: 60_000,
			now: 1_000,
		})
		expect(claim?.fence).toBeGreaterThan(4)
		// Whoever held 4, alive or not, is now ordered behind this holding.
		expect(await currentFence(runDir)).toBe(claim?.fence)
	})

	it('advertises an unreadable holding as available rather than dropping it', async () => {
		// The defect: the listing omitted `claim` entirely when the body was
		// unreadable, so the run appeared under `claimed: false` by looking
		// UNCLAIMED rather than by being reclaimable — a wedged run served as
		// free work on every sweep, forever.
		const store = new DiskCheckpointStore(
			{ baseDir: dir },
			{ tenantId: T1, projectId: P1, sessionId: S1 },
		)
		await store.writeCheckpoint(scope(), checkpoint('cp_1'))
		await mkdir(join(runDir, 'claims'), { recursive: true })
		await writeFile(join(runDir, 'claims', '2.json'), 'not json', 'utf-8')

		const page = await listDurableRuns(store, { tenantId: T1 }, { claimed: false, now: 5_000 })
		expect(page.entries.map((e) => e.runId)).toEqual(['run_a'])
		// Present on the row and marked expired: reclaimable, which is true.
		expect(page.entries[0]?.claim?.fence).toBe(2)
		expect(page.entries[0]?.claim?.expired).toBe(true)
	})

	it('checks the write fence without parsing a body', async () => {
		// The defect: `writeCheckpoint` skipped the fence check ENTIRELY when
		// the claim body was unreadable — at the one site whose whole job is
		// refusing. The fence is a file name now, so a corrupt body cannot
		// make the check skip itself.
		const store = new DiskCheckpointStore(
			{ baseDir: dir },
			{ tenantId: T1, projectId: P1, sessionId: S1 },
		)
		await mkdir(join(runDir, 'claims'), { recursive: true })
		await writeFile(join(runDir, 'claims', '9.json'), '{{{ corrupt', 'utf-8')

		await expect(store.writeCheckpoint(scope(), checkpoint('cp_2'), 3)).rejects.toThrow(
			/no longer holds it/,
		)
	})

	it('presents the fence on checkpoints a RUN writes, not only on direct store calls', async () => {
		// The defect that outranked every other: the fence never reached the
		// runtime. `CheckpointManager` called `writeCheckpoint(scope, cp)` with
		// two arguments at all four write sites, and an omitted fence is
		// always accepted — so a stalled worker's checkpoints went through
		// unrefused, which is verbatim the failure the feature claims to
		// prevent.
		//
		// Every test in the PR called `store.writeCheckpoint(..., fence)`
		// directly, a path no run takes, which is why thirty-four mutations
		// could not see it. This test enters where a run enters.
		const { CheckpointManager } = await import('../../../runtime/query/checkpoint.js')
		const store = new DiskCheckpointStore(
			{ baseDir: dir },
			{ tenantId: T1, projectId: P1, sessionId: S1 },
		)

		const stale = await acquireClaim(runDir, {
			holder: 'w1',
			ttlMs: 1,
			now: 1_000,
		})
		await acquireClaim(runDir, { holder: 'w2', ttlMs: 60_000, now: 5_000 })

		const manager = new CheckpointManager(store, scope())
		manager.setClaimFence(stale?.fence)

		const runMgr = {
			id: 'run_a' as RunId,
			messages: [],
			currentIteration: 1,
			tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			costInfo: { totalCost: 0 },
			getSession: () => ({ startedAt: 900 }),
		}

		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: the manager reads six fields.
			manager.create(runMgr as any, 1),
		).rejects.toThrow(/no longer holds it/)
	})

	it('never lets the fence name exist before the body under it', async () => {
		// The defect this file's design exists to remove, and the last one left
		// in it: `wx` is open-THEN-write, so between the two calls the winning
		// name exists and is EMPTY. A reader landing there parses nothing,
		// reports the live holding expired, and a second worker takes the next
		// fence. Their fences differ, so the loser's first checkpoint is
		// refused — and both have restored the run and executed its tools by
		// then, and tool side effects are fenced by nothing. CI reproduced it
		// once in three hundred cross-process runs.
		//
		// It is asserted on the FILE, not through `readClaim`, and that is the
		// point rather than a shortcut. Going through `readClaim` was tried and
		// is decoration: its `readdir` is a whole thread-pool round trip, so
		// its `readFile` always lands after the window has closed — 16,375
		// observations by 32 concurrent readers saw the defect zero times with
		// the defect present. A watcher spinning on the one name the next
		// acquire will take sees it immediately: ~29 empty bodies per 100
		// publishes on the `wx` publish, 0 on this one.
		//
		// The property is a statement about the layout, so it belongs at the
		// layout: from the instant the fence name is observable, its body is
		// whole.
		const claimsDir = join(runDir, 'claims')
		await mkdir(claimsDir, { recursive: true })

		let incomplete = 0
		let whole = 0

		for (let fence = 1; fence <= 120; fence++) {
			// The name this acquire is about to take: the counter is empty, so
			// the fences run 1..120 and each is known before it exists.
			const dest = join(claimsDir, `${fence}.json`)
			let stop = false
			const watcher = (async () => {
				while (!stop) {
					try {
						const raw = await readFile(dest, 'utf-8')
						if (raw.length === 0) incomplete++
						else {
							JSON.parse(raw)
							whole++
						}
					} catch (err) {
						// Not yet published, which is the honest other state.
						if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
						// A body that parsed as far as the reader got and no
						// further is the torn case, and it counts the same way.
						if (err instanceof SyntaxError) incomplete++
						else throw err
					}
				}
			})()

			const claim = await acquireClaim(runDir, {
				holder: 'w1',
				ttlMs: 60_000,
				now: 1_000,
			})
			stop = true
			await watcher
			expect(claim?.fence).toBe(fence)
		}

		// Not a vacuous pass: the watcher has to have caught the file existing.
		expect(whole).toBeGreaterThan(60)
		expect({ incomplete, whole }).toEqual({ incomplete: 0, whole })
	})

	it('never lets a scratch file be read as a holding', async () => {
		// The publish writes the body to a scratch name and links it into
		// place. A crash between the link and the unlink leaves the scratch
		// file behind, and it must be unmistakable for a claim: it carries a
		// parseable claim body, so anything matching it by shape rather than by
		// name would read it as one — and it is never the fence anybody holds.
		await acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 })
		const claimsDir = join(runDir, 'claims')
		await writeFile(
			join(claimsDir, '.tmp-999-1-abcdefgh-7'),
			JSON.stringify({ holder: 'ghost', expiresAt: 9_999_999 }),
			'utf-8',
		)

		expect(await currentFence(runDir)).toBe(1)
		expect((await readClaim(runDir))?.holder).toBe('w1')
		// And a publish that completes takes its own scratch file with it —
		// the sweep is for crashes, not for the ordinary path.
		expect((await readdir(claimsDir)).filter((n) => n.startsWith('.tmp-'))).toEqual([
			'.tmp-999-1-abcdefgh-7',
		])
	})

	it('reclaims a scratch file a crashed publish left behind', async () => {
		// Nothing used to. The name regex ignores a scratch file so it can
		// never be mistaken for a holding — and `prune` ignored it too, so a
		// worker crashing in that window leaked one per attempt forever.
		const claimsDir = join(runDir, 'claims')
		await mkdir(claimsDir, { recursive: true })
		const stale = join(claimsDir, '.tmp-999-1-deadbeef-1')
		await writeFile(stale, '{}', 'utf-8')
		// Aged past the sweep's threshold. Real time, not the lease clock: the
		// age of a file is a wall-clock question.
		const old = new Date(Date.now() - 30 * 60_000)
		await utimes(stale, old, old)

		const fresh = join(claimsDir, '.tmp-999-2-cafebabe-1')
		await writeFile(fresh, '{}', 'utf-8')

		await acquireClaim(runDir, { holder: 'w1', ttlMs: 60_000, now: 1_000 })

		const left = await readdir(claimsDir)
		expect(left).not.toContain('.tmp-999-1-deadbeef-1')
		// A scratch file young enough to belong to a publish in flight is left
		// alone; unlinking it would fail that publish's `link` for no reason.
		expect(left).toContain('.tmp-999-2-cafebabe-1')
	})

	it('keeps every holding on the record', async () => {
		const first = await acquireClaim(runDir, {
			holder: 'w1',
			ttlMs: 1,
			now: 1_000,
		})
		await acquireClaim(runDir, { holder: 'w2', ttlMs: 60_000, now: 5_000 })

		const names = await readdir(join(runDir, 'claims'))
		// Nothing is removed. A counter that can rewind is a counter that can
		// re-issue a number a stalled worker still believes it holds.
		expect(names.length).toBeGreaterThanOrEqual(2)
		expect((await readClaim(runDir))?.fence).toBeGreaterThan(first?.fence as number)
	})
})
