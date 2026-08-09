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
 *
 * **`.proc-test.ts`, not `.test.ts`, and that is the point of the suffix.**
 * `vitest.proc.config.ts` exists because a spawning test competes for CPU
 * hard enough to flake the timing-sensitive tests running beside it —
 * measured there as three different tests failing across two runs of the
 * full suite with one such file in, and none with it out. This file spawns
 * up to three node processes and sits out a real lease, so it belongs in
 * that suite; CI runs it as `pnpm --filter @namzu/sdk test:proc`, which
 * builds first, so the `dist` this depends on is there.
 *
 * (`run-claim.test.ts` still spawns from the unit suite. That is the older
 * arrangement, not a licence to add a second one to it.)
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
	readonly listed: number
	readonly drained: readonly string[]
	readonly skipped: readonly string[]
	readonly stale: readonly string[]
	readonly failed: readonly { runId: string; error: string }[]
	readonly unreleased: readonly { runId: string; error: string }[]
	readonly probes: readonly { runId: string; fencedOut: boolean }[]
}

/** Spawn one drainer to completion and read its report. */
async function drainer(holder: string, opts: { ttlMs?: number; barrier?: string } = {}) {
	const args = [
		worker,
		dist,
		dir,
		TENANT,
		PROJECT,
		SESSION,
		holder,
		String(opts.ttlMs ?? 60_000),
		'drain',
	]
	if (opts.barrier) args.push(opts.barrier)
	const { stdout } = await exec(process.execPath, args)
	return JSON.parse(stdout.trim()) as WorkerLine
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
		const lines = await Promise.all(['w0', 'w1'].map((h) => drainer(h, { barrier: at })))
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
			// The holder in the id is the process that reported draining it.
			//
			// Note what this does NOT show: that the marker was written WITH
			// the fence. A fenced write and an unfenced one are identical in
			// effect when the presented fence is current, so no assertion about
			// this checkpoint can tell them apart — measured, by mutating the
			// worker to drop `claim.fence` and watching this test stay green.
			// The probe below is the observable part.
			expect(lines.find((l) => l.holder === marker.holder)?.drained).toContain(runId)
			expect(marker.fence).toBeGreaterThan(0)
		}

		// Every drainer's deliberately superseded write was refused, and left
		// nothing behind. This is the fence being ENFORCED during an ordinary
		// drain, rather than only in the dead-holder case below.
		const probes = lines.flatMap((l) => l.probes)
		expect(probes).toHaveLength(runIds.length)
		expect(probes.every((p) => p.fencedOut)).toBe(true)
		for (const runId of runIds) {
			expect((await workMarkers(runId)).some((m) => m.id.startsWith('cp_probe_'))).toBe(false)
		}
	}, 60_000)

	it('does not re-do a run the other drainer already finished', async () => {
		const runIds = ['run_s0', 'run_s1', 'run_s2']
		await seed(runIds)

		// STAGGERED, not simultaneous, and that is the whole test. The
		// simultaneous case above passes even without the park filter: both
		// drainers page the queue before either has released anything, so the
		// second is excluded by the CLAIM and never reaches the window. The
		// window is the other order — one drainer lists AFTER the other
		// finished and released — and only a re-read under the claim closes
		// it. Running them in sequence makes that order certain instead of
		// leaving it to how fast the disk was that day.
		const first = await drainer('w_first')
		expect([...first.drained].sort()).toEqual(runIds)

		const second = await drainer('w_second')

		// Nothing left for it: doing the work answered each park, so the runs
		// no longer match the filter. Remove `park` from the drainer and this
		// is 3 runs drained a second time, with the claim raising no objection
		// whatever — it is not the claim's job.
		expect(second.drained).toEqual([])
		expect(second.failed).toEqual([])
		for (const runId of runIds) {
			expect(await workMarkers(runId)).toHaveLength(1)
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
