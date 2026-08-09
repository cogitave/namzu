/**
 * A drainer process, for the multi-process `drainRuns` test.
 *
 * A separate FILE rather than an inline closure because it has to import the
 * BUILT drain loop and store, and because the whole point is that the
 * contenders share nothing but the directory. Two drainers inside one
 * process are arbitrated by the event loop, not by the store — so a
 * single-process test reports "each run exactly once" against an
 * implementation with no exclusion in it at all. This is the same reason
 * `claim-worker.mjs` exists one directory over, and the same reason it could
 * not simply be reused: that worker races raw `claimRun` calls, and what is
 * under test here is the loop that composes claim, work and release.
 *
 * Each run it takes gets a checkpoint whose id names the holder and the
 * fence, written WITH that fence. The id is how the parent tells which
 * process did which run; the fence is what the store checks. A drainer that
 * passed the entry but not the claim would write unfenced checkpoints that
 * still look right in a listing.
 *
 * Usage:
 *   node drain-worker.mjs <dist> <baseDir> <tenant> <project> <session>
 *                         <holder> <ttlMs> <mode> [barrierEpochMs]
 *
 * mode `drain` — take everything, write a checkpoint per run, exit.
 * mode `hang`  — take the first run, write its checkpoint, then never
 *                finish. The parent kills it to simulate a worker that dies
 *                holding a lease.
 */

const [, , dist, baseDir, tenantId, projectId, sessionId, holder, ttlMs, mode, barrierMs] =
	process.argv

const from = (rel) => new URL(rel, `file://${dist.replace(/\\/g, '/')}/`).href
const { DiskCheckpointStore } = await import(from('store/run/checkpoint-disk.js'))
const { drainRuns } = await import(from('run/drain.js'))

const store = new DiskCheckpointStore({ baseDir }, { tenantId, projectId, sessionId })

let seq = 0
function checkpoint(runId, id) {
	seq += 1
	return {
		id,
		runId,
		iteration: 2,
		messages: [],
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0 },
		// The disk store REFUSES a checkpoint whose budget state is malformed
		// rather than resuming from it, so a worker that omitted this would
		// exercise the refusal path on every run and none of the drain.
		guardState: { iterationCount: 2, elapsedMs: 10 },
		createdAt: Date.now() + seq,
	}
}

// A barrier past node's startup, which varies by tens of milliseconds —
// easily enough for one drainer to finish the whole queue before another
// begins, and contenders that never overlap are not contending.
if (barrierMs) {
	const wait = Number(barrierMs) - Date.now()
	if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

const result = await drainRuns({
	store,
	scope: { tenantId, projectId, sessionId },
	holder,
	ttlMs: Number(ttlMs),
	// An approval inbox's filter. It is also what makes the pass
	// exactly-once: answering a park is what takes the run off this queue.
	park: ['outstanding'],
	onRun: async (entry, claim) => {
		const kind = mode === 'hang' ? 'started' : 'done'
		// A marker naming who did the work and under which holding, written
		// WITH that fence so the store itself vouches for it.
		await store.writeCheckpoint(
			entry,
			checkpoint(entry.runId, `cp_${kind}_${holder}_${claim.fence}`),
			claim.fence,
		)
		if (mode === 'hang') {
			// Tell the parent the lease is held and the work is under way, then
			// stop being a process that will ever finish. The park stays
			// outstanding, which is what makes the run reclaimable.
			process.stdout.write(`${JSON.stringify({ holding: entry.runId, fence: claim.fence })}\n`)
			await new Promise(() => {})
		}
		// Answer the park, the way `CheckpointManager.resolvePending` does: the
		// SAME checkpoint id, rewritten with `resolvedAt`. A resolution written
		// as a new checkpoint would leave the original park outstanding and the
		// run on the queue forever.
		const parkedId = entry.park.checkpointId
		const parked = await store.readCheckpoint(entry, parkedId)
		await store.writeCheckpoint(
			entry,
			{ ...parked, pending: { ...parked.pending, resolvedAt: Date.now() } },
			claim.fence,
		)
	},
})

process.stdout.write(`${JSON.stringify({ holder, ...result })}\n`)
