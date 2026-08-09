/**
 * `drainRuns` across REAL processes.
 *
 * A drain loop tested inside one process proves nothing about a claim: the
 * event loop serializes the two drainers, so "each run exactly once" holds
 * against an implementation with no exclusion in it at all. What is under
 * test here is the composition — take, work, release, and the fence that
 * every durable write carries — arbitrated by nothing but the directory the
 * contenders share.
 *
 * Runs against `dist`, deliberately: separate node processes with no loader,
 * importing the built store and the built loop, exactly as a host would.
 * That means `pnpm --filter @namzu/sdk build` must have run — the same
 * precondition `run-claim.test.ts` carries.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'
import { DiskCheckpointStore } from '../../store/run/checkpoint-disk.js'
import type { HITLDecisionRequest, IterationCheckpoint } from '../../types/hitl/index.js'
import type { CheckpointId, ProjectId, RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { CheckpointRunScope } from '../../types/run/checkpoint-store.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', '..', '..', 'dist')
const worker = join(here, 'drain-worker.mjs')

const TENANT = 'tnt_drain' as TenantId
const PROJECT = 'prj_drain' as ProjectId
const SESSION = 'ses_drain' as SessionId

interface WorkerLine {
	readonly holder: string
	readonly drained: readonly string[]
	readonly skipped: readonly string[]
	readonly stale: readonly string[]
	readonly failed: readonly { runId: string; error: string }[]
	readonly unreleased: readonly { runId: string; error: string }[]
}

let dir: string
let store: DiskCheckpointStore

function scope(runId: string): CheckpointRunScope {
	return { tenantId: TENANT, projectId: PROJECT, sessionId: SESSION, runId: runId as RunId }
}

let seq = 0

/** The shape the checkpoint manager writes; the disk store refuses less. */
function parkedCheckpoint(runId: string): IterationCheckpoint {
	seq += 1
	const id = `cp_seed_${seq}` as CheckpointId
	const request: HITLDecisionRequest = {
		type: 'tool_review',
		runId: runId as RunId,
		checkpointId: id,
		toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
	}
	return {
		id,
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
		pending: { request, parkedAt: 1_000 },
	}
}

async function seed(runIds: readonly string[]): Promise<void> {
	for (const runId of runIds) await store.writeCheckpoint(scope(runId), parkedCheckpoint(runId))
}

/**
 * `cp_<kind>_<holder>_<fence>` — the marker a worker leaves on a run.
 *
 * Parsed with an anchored pattern rather than `split('_')[3]`, which is what
 * the first draft did: holders here are `w_dead` and `w_live`, so the index
 * landed on `live` and `Number(…)` produced `NaN` — and `expect(NaN).
 * toBeGreaterThan(1)` fails loudly only because it was the assertion under
 * test. A looser matcher would have read green on an unparsed field.
 */
const MARKER = /^cp_(done|started)_(.+)_(\d+)$/

interface Marker {
	readonly kind: 'done' | 'started'
	readonly holder: string
	readonly fence: number
	readonly id: string
}

/** Every worker marker a run accumulated, oldest first. */
async function workMarkers(runId: string): Promise<Marker[]> {
	const cps = await store.listCheckpoints(scope(runId))
	return cps.flatMap((c) => {
		const m = MARKER.exec(String(c.id))
		return m
			? [
					{
						kind: m[1] as 'done' | 'started',
						holder: m[2] as string,
						fence: Number(m[3]),
						id: String(c.id),
					},
				]
			: []
	})
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'namzu-drain-'))
	store = new DiskCheckpointStore(
		{ baseDir: dir },
		{ tenantId: TENANT, projectId: PROJECT, sessionId: SESSION },
	)
})

afterEach(async () => {
	await removeTempDirAsync(dir)
})

describe('two drainer processes over one queue', () => {
	it('resumes each parked run exactly once, under the fence of whoever took it', async () => {
		const runIds = ['run_p0', 'run_p1', 'run_p2']
		await seed(runIds)

		// A barrier past node's startup so the two actually contend. Startup
		// varies by tens of milliseconds, which is easily enough for one
		// drainer to empty the queue before the other begins — and contenders
		// that never overlap are not contending.
		const at = String(Date.now() + 1_500)
		const results = await Promise.all(
			['w0', 'w1'].map((holder) =>
				exec(process.execPath, [
					worker,
					dist,
					dir,
					TENANT,
					PROJECT,
					SESSION,
					holder,
					'60000',
					'drain',
					at,
				]),
			),
		)

		const lines = results.map((r) => JSON.parse(r.stdout.trim()) as WorkerLine)
		const drained = lines.flatMap((l) => l.drained)

		// Exactly once IN TOTAL. Two drainers that both took a run would both
		// restore its checkpoint, both execute its tools and both write under
		// one run id — and the listing would look healthy afterwards.
		//
		// The first version of this test failed here for real, and the failure
		// was the design's rather than the test's: a released run returns to
		// the queue, so the drainer that listed second claimed a run the first
		// had already finished. The claim cannot close that window — only
		// re-reading the park under the claim can, which is what `stale` is.
		expect([...drained].sort()).toEqual(runIds)
		expect(lines.flatMap((l) => l.failed)).toEqual([])
		expect(lines.flatMap((l) => l.unreleased)).toEqual([])
		// Every row one drainer saw and the other had already done is accounted
		// for as contention, not as work.
		expect(
			lines.flatMap((l) => [...l.drained, ...l.skipped, ...l.stale]).length,
		).toBeGreaterThanOrEqual(runIds.length)

		// And the durable record agrees with the report. A drainer could report
		// a run it never wrote for; the store is the only witness that matters.
		for (const runId of runIds) {
			const markers = await workMarkers(runId)
			expect(markers).toHaveLength(1)
			const [marker] = markers as [Marker]
			// Written WITH that fence, so the store itself accepted it as the
			// current holding, and the holder in the id is the process that
			// reported draining this run.
			expect(lines.find((l) => l.holder === marker.holder)?.drained).toContain(runId)
			expect(marker.fence).toBeGreaterThan(0)
		}
	}, 60_000)
})

describe('a drainer that dies holding a lease', () => {
	it('hands the run to the next drainer once the lease lapses, and fences the corpse out', async () => {
		const runId = 'run_dead'
		await seed([runId])

		// Short enough that the test does not sit out a real lease, long enough
		// that the first drainer genuinely holds it while it is killed.
		const TTL_MS = 2_000

		const held = await new Promise<{ holding: string; fence: number }>((resolve, reject) => {
			const child = spawn(process.execPath, [
				worker,
				dist,
				dir,
				TENANT,
				PROJECT,
				SESSION,
				'w_dead',
				String(TTL_MS),
				'hang',
			])
			let buf = ''
			child.stdout.on('data', (d: Buffer) => {
				buf += d.toString()
				const line = buf.split('\n')[0]
				if (!line) return
				// It has claimed and written; killing it now is a worker that dies
				// mid-run rather than one that never started.
				child.kill('SIGKILL')
				resolve(JSON.parse(line) as { holding: string; fence: number })
			})
			child.on('error', reject)
			child.on('exit', (code, signal) => {
				if (buf.trim().length === 0) reject(new Error(`worker exited ${code} ${signal}`))
			})
		})

		expect(held.holding).toBe(runId)
		// The run is now held by a process that no longer exists. Nothing
		// notifies the store; only the expiry makes it recoverable.
		expect((await workMarkers(runId)).map((m) => m.id)).toEqual([`cp_started_w_dead_${held.fence}`])

		await new Promise((r) => setTimeout(r, TTL_MS + 300))

		const second = JSON.parse(
			(
				await exec(process.execPath, [
					worker,
					dist,
					dir,
					TENANT,
					PROJECT,
					SESSION,
					'w_live',
					'60000',
					'drain',
				])
			).stdout.trim(),
		) as WorkerLine

		expect(second.drained).toEqual([runId])
		const markers = await workMarkers(runId)
		expect(markers).toHaveLength(2)
		const takeoverFence = (markers.find((m) => m.kind === 'done') as Marker).fence
		// Strictly greater. A reclaim that reused the number would fence nobody
		// out, and the dead holder's write below would be accepted beside the
		// live one.
		expect(takeoverFence).toBeGreaterThan(held.fence)

		// The corpse wakes up. From inside, a long pause, a suspended container
		// and a partition all look like time not passing, so it believes it
		// still holds the run — and the only moment it can learn otherwise is
		// the write.
		await expect(
			store.writeCheckpoint(
				scope(runId),
				{ ...parkedCheckpoint(runId), id: 'cp_late_w_dead' as CheckpointId },
				held.fence,
			),
		).rejects.toThrow(/refusing a write/)
		// And it wrote nothing: a refusal that still landed a file would be the
		// silent divergence the fence exists to prevent.
		expect(await workMarkers(runId)).toHaveLength(2)
	}, 60_000)
})
